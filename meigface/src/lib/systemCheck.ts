/**
 * Pre-calibration system check.
 *
 * Verifies that the three local engines actually work with the user-selected
 * executables/models, by exercising each one end to end:
 *  1. LLM  — start, ask a trivial question, require a non-empty reply, stop.
 *  2. STT  — start, capture one spoken utterance and require a non-empty
 *            transcription, stop.
 *  3. TTS  — synthesize a word with the first available voice for the language
 *            (any gender) and play it back.
 *
 * It reuses the same backend commands and audio modules as the conversation
 * loop, so a pass means the real session pipeline is wired correctly.
 */

import { invoke } from "@tauri-apps/api/core";
import { MicRecorder } from "./audio/recorder";
import { SpeechPlayer } from "./audio/player";
import { transcribe } from "./audio/transcribe";

/** Which engine a check is exercising (and which one failed, on failure). */
export type CheckStep = "llm" | "stt" | "tts";

/** Engine paths and run options needed to drive the checks. */
export interface SystemCheckConfig {
  serverPath: string;
  modelPath: string;
  gpuLayers: number;
  whisperPath: string;
  whisperModelPath: string;
  /** Vulkan/CUDA device index for whisper-server; undefined = engine default. */
  sttGpuDevice?: number;
  piperPath: string;
  /** Spoken language, "it" or "en". */
  language: string;
  /** Word the user is asked to say and that Piper speaks back (e.g. "Ciao"). */
  word: string;
  /** Trivial prompt sent to the LLM (e.g. "Rispondi solo con «ok»."). */
  llmPrompt: string;
}

/** Progress callbacks, used to drive the info dialog's live message. */
export interface SystemCheckProgress {
  onLlm?: () => void;
  onSttStarting?: () => void;
  onSttListening?: () => void;
  onTts?: () => void;
}

/** Outcome of the whole check. */
export type SystemCheckResult =
  | { ok: true }
  | { ok: false; step: CheckStep; reason: "error" | "noSpeech"; detail: string };

/** Status object returned by the llm_/stt_ commands. */
interface EngineStatus {
  running: boolean;
  base_url: string | null;
}

/** How long to wait for the user to speak before giving up (STT step). */
const STT_LISTEN_TIMEOUT_MS = 12000;

/** Stop an engine, ignoring the error raised when it is not running. */
async function safeStop(command: "llm_stop" | "stt_stop"): Promise<void> {
  try {
    await invoke(command);
  } catch {
    // Not running (or already stopped): nothing to do.
  }
}

/**
 * Return the first gender folder ("female" then "male") that has at least one
 * voice for the language, or null if neither does.
 */
async function firstVoiceGender(
  language: string,
): Promise<"female" | "male" | null> {
  for (const gender of ["female", "male"] as const) {
    try {
      const voices = await invoke<string[]>("list_voices", { language, gender });
      if (voices.length > 0) return gender;
    } catch {
      // Folder missing for this gender: try the other one.
    }
  }
  return null;
}

export async function runSystemCheck(
  config: SystemCheckConfig,
  progress: SystemCheckProgress = {},
): Promise<SystemCheckResult> {
  // 1. LLM ------------------------------------------------------------------
  progress.onLlm?.();
  try {
    await safeStop("llm_stop");
    await invoke<EngineStatus>("llm_start", {
      serverPath: config.serverPath,
      modelPath: config.modelPath,
      nGpuLayers: config.gpuLayers,
    });
    const reply = await invoke<string>("llm_chat", {
      messages: [{ role: "user", content: config.llmPrompt }],
      temperature: 0,
      maxTokens: 16,
    });
    if (!reply.trim()) {
      return { ok: false, step: "llm", reason: "error", detail: "empty reply" };
    }
  } catch (err) {
    return { ok: false, step: "llm", reason: "error", detail: String(err) };
  } finally {
    await safeStop("llm_stop");
  }

  // 2. STT ------------------------------------------------------------------
  progress.onSttStarting?.();
  try {
    await safeStop("stt_stop");
    const status = await invoke<EngineStatus>("stt_start", {
      serverPath: config.whisperPath,
      modelPath: config.whisperModelPath,
      gpuDevice: config.sttGpuDevice,
    });
    if (!status.base_url) {
      return { ok: false, step: "stt", reason: "error", detail: "no base URL" };
    }

    progress.onSttListening?.();
    const recorder = new MicRecorder({
      silenceDurationMs: 900,
      maxDurationMs: 8000,
    });
    // captureUtterance never resolves if the user stays silent, so cancel it
    // after a timeout and treat that as "heard nothing".
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      recorder.cancel();
    }, STT_LISTEN_TIMEOUT_MS);

    let wav;
    try {
      wav = await recorder.captureUtterance();
    } catch (err) {
      return timedOut
        ? { ok: false, step: "stt", reason: "noSpeech", detail: "" }
        : { ok: false, step: "stt", reason: "error", detail: String(err) };
    } finally {
      clearTimeout(timer);
    }

    const text = await transcribe(status.base_url, wav, {
      language: config.language,
    });
    if (!text.trim()) {
      return { ok: false, step: "stt", reason: "noSpeech", detail: "" };
    }
  } catch (err) {
    return { ok: false, step: "stt", reason: "error", detail: String(err) };
  } finally {
    await safeStop("stt_stop");
  }

  // 3. TTS ------------------------------------------------------------------
  progress.onTts?.();
  try {
    const gender = await firstVoiceGender(config.language);
    if (!gender) {
      return {
        ok: false,
        step: "tts",
        reason: "error",
        detail: "no voice for language",
      };
    }
    const audio = await invoke<ArrayBuffer>("tts_synthesize", {
      piperPath: config.piperPath,
      language: config.language,
      gender,
      text: config.word,
    });
    await new SpeechPlayer().play(audio);
  } catch (err) {
    return { ok: false, step: "tts", reason: "error", detail: String(err) };
  }

  return { ok: true };
}