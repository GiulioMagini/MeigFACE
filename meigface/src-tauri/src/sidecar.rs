//! Local inference-server process lifecycle management.
//!
//! Manages user-provided HTTP inference servers as child processes and owns
//! their lifetime (start, readiness detection, shutdown). The same generic
//! manager serves both llama.cpp's `llama-server` (the LLM) and whisper.cpp's
//! `whisper-server` (speech-to-text); the two live side by side in [`Engines`].
//!
//! Each server is spawned from its **own directory** (its parent folder
//! becomes the child's working directory), so the libraries shipped next to
//! it are found by the OS loader. This lets the user unzip a build (CPU or
//! GPU) anywhere and just point the app at the executable — no copying of
//! DLLs, no app-managed folder.
//!
//! Binding to the loopback interface is enforced here (the host and port are
//! injected by this module, not supplied by the caller), so a server can
//! never be exposed on the network — a hard requirement for an offline,
//! GDPR-compliant system. This module knows nothing about prompts, audio or
//! conversation: it only guarantees a healthy local endpoint at `base_url()`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use serde::{Deserialize, Serialize};

/// Loopback host every server binds to. Hardcoded — never configurable — so
/// no endpoint can be reached from the network. Part of the security model.
const LOOPBACK_HOST: &str = "127.0.0.1";

/// Maximum time to wait for a server to load its model and become ready.
const READINESS_TIMEOUT: Duration = Duration::from_secs(120);

/// Interval between readiness polls.
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Maximum time to wait for the device-probe (`--list-devices`) call.
const DEVICE_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Hard cap on a single chat request. Generous enough for a long CPU-only
/// generation, but guarantees a hung server can never stall a turn forever.
const CHAT_TIMEOUT: Duration = Duration::from_secs(120);

/// Per-request timeout for one readiness poll, so a single hanging health
/// check cannot silently consume the whole readiness window.
const READINESS_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Minimum GPU VRAM (in MiB) below which inference stays on the CPU. Above
/// it, all layers are offloaded; the project's target models (2–4B, 4-bit)
/// fit comfortably and llama.cpp caps the count to the model's real layers.
const MIN_VRAM_FOR_OFFLOAD_MIB: u64 = 4096;

/// Value passed as `--n-gpu-layers` to offload every layer to the GPU.
/// llama.cpp caps it to the model's actual layer count.
const OFFLOAD_ALL_LAYERS: u32 = 999;

/// Windows process creation flag (CREATE_NO_WINDOW): no console window for
/// the child. Without it, launching a server flashes a terminal window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Errors that can occur while managing an inference-server process.
#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    /// The selected server executable does not exist on disk.
    #[error("server executable not found: {0:?}")]
    ServerNotFound(PathBuf),

    /// `start` was called while a server was already running.
    #[error("server is already running")]
    AlreadyRunning,

    /// The process could not be spawned (or an I/O error occurred).
    #[error("failed to spawn server: {0}")]
    Spawn(String),

    /// The process exited on its own before becoming ready (e.g. an invalid
    /// model file, an unsupported flag, the port already in use, or a
    /// GPU/driver error).
    #[error("server exited during startup (exit code: {0:?})")]
    EarlyExit(Option<i32>),

    /// The process stayed alive but never answered the readiness check.
    #[error("server did not become ready within {0:?}")]
    ReadinessTimeout(Duration),

    /// Piper exited with a non-zero status while synthesizing speech.
    #[error("speech synthesis failed (exit code: {0:?})")]
    SynthesisFailed(Option<i32>),

    /// The Piper voice config (.onnx.json) is missing or invalid.
    #[error("invalid Piper voice: {0}")]
    Voice(String),

    /// A chat request to the LLM server failed.
    #[error("LLM chat request failed: {0}")]
    Chat(String),

    /// Killing the running process failed during shutdown.
    #[error("failed to stop server: {0}")]
    Stop(String),

    /// The internal state lock was poisoned by a panic in another thread.
    #[error("server state lock was poisoned")]
    LockPoisoned,
}

/// How readiness is decided once a server has been spawned.
#[derive(Debug, Clone)]
pub struct Readiness {
    /// HTTP path polled until the server is ready (e.g. `/health` or `/`).
    pub path: &'static str,
    /// When true, only a 2xx response counts as ready (llama-server's
    /// `/health` returns 503 while the model loads). When false, any HTTP
    /// response means "listening" — whisper-server binds only after the
    /// model is loaded, so a reply of any status implies readiness.
    pub require_success: bool,
}

/// Everything needed to launch one inference server.
///
/// `args` carries only the server-specific flags (model path, context size,
/// …); `--host` and `--port` are injected by [`HttpSidecar::start`] from the
/// loopback host and `port` below, so the loopback invariant is enforced
/// centrally and the configured port always matches the readiness URL.
#[derive(Debug, Clone)]
pub struct SidecarParams {
    /// Absolute path to the server executable the user selected.
    pub executable: PathBuf,
    /// Server-specific arguments (without `--host`/`--port`).
    pub args: Vec<OsString>,
    /// Loopback port the server listens on.
    pub port: u16,
    /// How to detect that the server is ready.
    pub readiness: Readiness,
}

/// Inner mutable state guarded by a single lock.
#[derive(Default)]
struct SidecarState {
    /// Handle to the running child, taken and killed on shutdown.
    child: Option<Child>,
    /// Port the running child bound to, used to build the base URL.
    port: Option<u16>,
}

/// Manages a single HTTP inference-server child process.
pub struct HttpSidecar {
    state: Mutex<SidecarState>,
}

impl HttpSidecar {
    /// Create an idle manager with no running process.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SidecarState::default()),
        }
    }

    /// Launch the server and wait until it is ready. On success the child is
    /// stored for later shutdown.
    ///
    /// Fails fast if the executable is missing, if a server is already
    /// running, if the process cannot be spawned, if it exits during startup,
    /// or if it does not pass the readiness check within
    /// [`READINESS_TIMEOUT`].
    pub async fn start(&self, params: SidecarParams) -> Result<(), SidecarError> {
        // Reject if a child is already tracked. The guard is dropped before
        // any await — a std Mutex must never be held across an await point.
        {
            let state = self.state.lock().map_err(|_| SidecarError::LockPoisoned)?;
            if state.child.is_some() {
                return Err(SidecarError::AlreadyRunning);
            }
        }

        if !params.executable.is_file() {
            return Err(SidecarError::ServerNotFound(params.executable));
        }

        let port_arg = params.port.to_string();
        let mut command = Command::new(&params.executable);
        command
            // Host/port are injected here (not by the caller) to keep the
            // loopback-only invariant central and unforgettable.
            .arg("--host")
            .arg(LOOPBACK_HOST)
            .arg("--port")
            .arg(port_arg.as_str())
            .args(&params.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Kill the server if this handle is dropped without an explicit
            // stop (e.g. on app teardown).
            .kill_on_drop(true);

        // Run from the executable's own folder so the OS loader finds the
        // libraries shipped alongside it.
        if let Some(dir) = params.executable.parent() {
            command.current_dir(dir);
        }

        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|e| SidecarError::Spawn(e.to_string()))?;

        // Drain stdout/stderr for the whole lifetime so the child never blocks
        // on a full pipe, and surface the server's logs (startup errors too).
        if let Some(stdout) = child.stdout.take() {
            spawn_log_drain(stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_drain(stderr);
        }

        // Poll the readiness endpoint until the server answers, the process
        // dies, or the timeout elapses.
        let health_url = format!("http://{LOOPBACK_HOST}:{}{}", params.port, params.readiness.path);
        // Per-request timeout: a poll that hangs must not eat the readiness
        // window without the deadline check ever running.
        let client = reqwest::Client::builder()
            .timeout(READINESS_REQUEST_TIMEOUT)
            .build()
            .map_err(|e| SidecarError::Spawn(e.to_string()))?;
        let deadline = Instant::now() + READINESS_TIMEOUT;

        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| SidecarError::Spawn(e.to_string()))?
            {
                return Err(SidecarError::EarlyExit(status.code()));
            }
            if Instant::now() >= deadline {
                let _ = child.start_kill();
                return Err(SidecarError::ReadinessTimeout(READINESS_TIMEOUT));
            }
            // Break as soon as the server answers; when readiness requires a
            // success status, only a 2xx response counts as ready.
            if let Ok(response) = client.get(health_url.as_str()).send().await
                && (!params.readiness.require_success || response.status().is_success())
            {
                break;
            }
            tokio::time::sleep(READINESS_POLL_INTERVAL).await;
        }

        let mut state = self.state.lock().map_err(|_| SidecarError::LockPoisoned)?;
        state.child = Some(child);
        state.port = Some(params.port);
        log::info!("[sidecar] server ready on http://{LOOPBACK_HOST}:{}", params.port);
        Ok(())
    }

    /// Terminate the running server, if any. Safe to call when nothing is
    /// running (no-op). Should be invoked on app shutdown.
    pub fn stop(&self) -> Result<(), SidecarError> {
        let mut state = self.state.lock().map_err(|_| SidecarError::LockPoisoned)?;
        state.port = None;
        if let Some(mut child) = state.child.take() {
            // start_kill signals termination without awaiting the reap, so
            // this stays callable from synchronous contexts (e.g. exit hook).
            child.start_kill().map_err(|e| SidecarError::Stop(e.to_string()))?;
            log::info!("[sidecar] server stopped");
        }
        Ok(())
    }

    /// Whether a server child is currently being tracked as running.
    pub fn is_running(&self) -> bool {
        self.state
            .lock()
            .map(|s| s.child.is_some())
            .unwrap_or(false)
    }

    /// Base URL of the running server (e.g. `http://127.0.0.1:8080`), or
    /// `None` if no server is running.
    pub fn base_url(&self) -> Option<String> {
        let state = self.state.lock().ok()?;
        state.port.map(|port| format!("http://{LOOPBACK_HOST}:{port}"))
    }
}

/// The set of local inference servers managed by the app, shared via Tauri's
/// managed state. Keeping them in one container lets a single `manage` call
/// and a single shutdown hook cover every engine.
pub struct Engines {
    /// The LLM server (llama-server).
    pub llm: HttpSidecar,
    /// The speech-to-text server (whisper-server).
    pub stt: HttpSidecar,
}

impl Engines {
    /// Create both engines in the idle (not running) state.
    pub fn new() -> Self {
        Self {
            llm: HttpSidecar::new(),
            stt: HttpSidecar::new(),
        }
    }
}

/// Spawn a background task that forwards a child's output stream to the log,
/// line by line, so the server's diagnostics are visible when logging is on.
fn spawn_log_drain<R>(stream: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("[sidecar] {line}");
        }
    });
}

/// Probe a llama-server build for usable GPU devices and suggest a sensible
/// `--n-gpu-layers` default.
///
/// Runs `<server> --list-devices`, which reports only the devices the
/// *selected build* can actually use (a CPU-only build lists none, so it
/// correctly yields 0 even if a GPU is physically present). The decision is
/// based on the largest GPU VRAM reported. The exact layer count cannot be
/// known without the model, so "offload all" is a high value llama.cpp caps.
pub async fn suggest_gpu_layers(server_path: &Path) -> Result<u32, SidecarError> {
    if !server_path.is_file() {
        return Err(SidecarError::ServerNotFound(server_path.to_path_buf()));
    }

    let mut command = Command::new(server_path);
    command.arg("--list-devices");
    if let Some(dir) = server_path.parent() {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = match tokio::time::timeout(DEVICE_PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(SidecarError::Spawn(e.to_string())),
        Err(_) => return Err(SidecarError::Spawn("device probe timed out".to_string())),
    };

    // Device info may land on either stream depending on the build.
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));

    Ok(match max_device_vram_mib(&text) {
        Some(vram) if vram >= MIN_VRAM_FOR_OFFLOAD_MIB => OFFLOAD_ALL_LAYERS,
        _ => 0,
    })
}

/// Bounds for the speech-speed multiplier. Below the minimum Piper slurs
/// phonemes together, above it the delivery turns unnaturally slow; clamping
/// here rather than trusting the caller keeps a hand-edited settings file from
/// producing unusable audio.
const MIN_SPEECH_SPEED: f32 = 0.7;
const MAX_SPEECH_SPEED: f32 = 1.4;

/// Synthesize `text` with Piper and return it as WAV bytes (PCM 16-bit mono),
/// without ever writing a file.
///
/// Piper streams headerless raw PCM to stdout (`--output-raw`) at the voice's
/// sample rate, which is read from the voice's `.onnx.json` config; a WAV
/// header is then prepended so the frontend can decode it directly. Piper is
/// run from its own directory so it finds its libraries and `espeak-ng-data`.
///
/// `speed` is a relative multiplier where 1.0 means "the rate this voice was
/// tuned for" and higher is faster. It scales the voice's own `length_scale`
/// instead of replacing it, so voices authored at a rate other than 1.0 still
/// sound as intended at the neutral setting.
pub async fn synthesize_speech(
    piper_path: &Path,
    voice_path: &Path,
    text: &str,
    speed: f32,
) -> Result<Vec<u8>, SidecarError> {
    // The voice config sits next to the model as "<voice>.onnx.json".
    let mut config_path = voice_path.as_os_str().to_owned();
    config_path.push(".json");
    let config_raw = tokio::fs::read_to_string(&config_path)
        .await
        .map_err(|e| SidecarError::Voice(format!("cannot read voice config: {e}")))?;
    let config: VoiceConfig = serde_json::from_str(&config_raw)
        .map_err(|e| SidecarError::Voice(format!("invalid voice config: {e}")))?;
    let sample_rate = config.audio.sample_rate;
    // Piper measures phoneme length, so its scale is the inverse of speed:
    // higher length scale = slower speech. A non-finite value (a corrupt
    // setting) falls back to neutral rather than reaching the process argument.
    let voice_length_scale = config.inference.and_then(|i| i.length_scale).unwrap_or(1.0);
    let speed = if speed.is_finite() {
        speed.clamp(MIN_SPEECH_SPEED, MAX_SPEECH_SPEED)
    } else {
        1.0
    };
    let length_scale = voice_length_scale / speed;

    let mut command = Command::new(piper_path);
    command.arg("--model").arg(voice_path);
    // Only override the voice's own rate when the user actually moved the
    // slider: at the neutral setting Piper is left to read every inference
    // parameter from the voice config, exactly as before this option existed.
    if (length_scale - voice_length_scale).abs() > f32::EPSILON {
        command
            .arg("--length-scale")
            .arg(format!("{length_scale:.3}"));
    }
    command
        .arg("--output-raw")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = piper_path.parent() {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| SidecarError::Spawn(e.to_string()))?;

    // Feed the text, then close stdin (the handle drops here) so Piper
    // synthesizes and exits.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| SidecarError::Spawn(e.to_string()))?;
    }

    // Collect raw PCM from stdout (stderr carries Piper's diagnostics).
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| SidecarError::Spawn(e.to_string()))?;
    if !output.status.success() {
        log::error!(
            "[piper] synthesis failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return Err(SidecarError::SynthesisFailed(output.status.code()));
    }

    Ok(wav_from_pcm16(&output.stdout, sample_rate))
}

/// Minimal view of a Piper voice config: the sample rate needed for the WAV
/// header, plus the voice's own phoneme length scale, i.e. the neutral rate its
/// author tuned it for. Both `inference` and its field are optional because
/// older voice configs omit the section entirely.
#[derive(Deserialize)]
struct VoiceConfig {
    audio: VoiceAudio,
    inference: Option<VoiceInference>,
}

#[derive(Deserialize)]
struct VoiceAudio {
    sample_rate: u32,
}

#[derive(Deserialize)]
struct VoiceInference {
    length_scale: Option<f32>,
}

/// Wrap raw 16-bit mono PCM in a WAV container at the given sample rate.
fn wav_from_pcm16(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_size = pcm.len() as u32;
    let byte_rate = sample_rate * 2; // mono, 2 bytes per sample
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // audio format: PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // channels: mono
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

/// Extract the largest device VRAM (in MiB) from `--list-devices` output.
///
/// Device lines look like `CUDA0: NVIDIA ... (15944 MiB, 14143 MiB free)`;
/// the first number is the total VRAM. The CPU device is not listed, so any
/// match is a GPU/accelerator. Returns `None` when no GPU device is found.
fn max_device_vram_mib(output: &str) -> Option<u64> {
    let mut max: Option<u64> = None;
    for line in output.lines() {
        if !line.contains("MiB free)") {
            continue;
        }
        let Some(open) = line.rfind('(') else {
            continue;
        };
        let after = &line[open + 1..];
        let Some(mib_pos) = after.find(" MiB") else {
            continue;
        };
        if let Ok(value) = after[..mib_pos].trim().parse::<u64>() {
            max = Some(max.map_or(value, |m| m.max(value)));
        }
    }
    max
}

/// One message in a chat conversation, exchanged with the LLM server.
/// Mirrors the OpenAI message shape (`role` + `content`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Request body for the OpenAI-compatible chat endpoint. `stream` is always
/// false here: we want the full answer in one response (the conversational
/// loop generates speech from the complete reply).
#[derive(Serialize)]
struct ChatRequest<'a> {
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// Disable Qwen-style reasoning so the answer lands in `content` and the
    /// model stays fast. Honoured only when llama-server runs with `--jinja`.
    chat_template_kwargs: ChatTemplateKwargs,
}

#[derive(Serialize)]
struct ChatTemplateKwargs {
    enable_thinking: bool,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Deserialize)]
struct ChatResponseMessage {
    #[serde(default)]
    content: String,
    /// Filled instead of `content` when the model reasons; used as a fallback
    /// so a thinking reply is never returned completely empty.
    #[serde(default)]
    reasoning_content: Option<String>,
}

/// Shared HTTP client for chat requests. One client for the process keeps the
/// loopback connection alive across turns (no per-turn TCP setup) and applies
/// [`CHAT_TIMEOUT`] to every request.
static CHAT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Return the lazily built shared chat client. Building it cannot realistically
/// fail with these options; a default client is the safe fallback.
fn chat_client() -> &'static reqwest::Client {
    CHAT_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(CHAT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Send a chat conversation to a running LLM server and return the assistant's
/// reply text. `base_url` is the server's loopback base (from [`HttpSidecar::base_url`]).
///
/// Reused both by the live conversation and, later, by the session-summary
/// step, since both just need "given these messages, return the model's reply".
pub async fn chat_completion(
    base_url: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Result<String, SidecarError> {
    let url = format!("{base_url}/v1/chat/completions");
    let body = ChatRequest {
        messages,
        stream: false,
        temperature,
        max_tokens,
        chat_template_kwargs: ChatTemplateKwargs {
            enable_thinking: false,
        },
    };

    let response = chat_client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| SidecarError::Chat(e.to_string()))?;

    if !response.status().is_success() {
        let code = response.status().as_u16();
        let detail = response.text().await.unwrap_or_default();
        return Err(SidecarError::Chat(format!("HTTP {code}: {detail}")));
    }

    let parsed: ChatResponse = response
        .json()
        .await
        .map_err(|e| SidecarError::Chat(e.to_string()))?;

    let message = parsed
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message)
        .ok_or_else(|| SidecarError::Chat("the LLM returned no choices".to_string()))?;

    if !message.content.trim().is_empty() {
        Ok(message.content)
    } else if let Some(reasoning) = message.reasoning_content.filter(|r| !r.trim().is_empty()) {
        Ok(reasoning)
    } else {
        Err(SidecarError::Chat("the LLM returned an empty reply".to_string()))
    }
}