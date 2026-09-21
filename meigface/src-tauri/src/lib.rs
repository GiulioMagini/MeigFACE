//! MeigFACE - Eye Contact Training System
//!
//! Tauri application entry point. Registers plugins and starts the main
//! window maximized, so the calibration uses the full usable viewport
//! (the OS work area) while leaving the taskbar / dock visible.

// --- Internal modules ---
mod sidecar;
mod bridge;
mod agent;

use tauri::Manager;

// Required by Tauri's build system even for desktop-only targets — safe to ignore
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Route the `log` macros (sidecar diagnostics, drained server output)
        // to stdout and the platform log dir; without this plugin every
        // log::… call in sidecar.rs is silently dropped.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Debug)
                // reqwest logs one debug line per readiness poll: dozens per
                // server start, pure noise that fills the file and rotates
                // away the useful sidecar diagnostics. Keep only its warnings.
                .level_for("reqwest", log::LevelFilter::Warn)
                // Bounded, predictable file size: cap at 1 MiB, discard the
                // old file on rotation (default strategy). Plenty of room for
                // several sessions of sidecar diagnostics, still trivially
                // small on disk.
                .max_file_size(1024 * 1024)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(crate::sidecar::Engines::new())
        .setup(|app| {
            // Ensure the base voices layout exists so recalibration always has
            // folders to look in, even if the user deleted the voices folder.
            if let Err(err) = bridge::ensure_base_voices(app.handle()) {
                eprintln!("[meigface] could not ensure base voices: {err}");
            }
            if let Some(window) = app.get_webview_window("main") {
                // Best-effort: if maximizing fails, the window keeps its
                // configured size rather than failing to launch.
                if let Err(err) = ensure_maximized(&window) {
                    eprintln!("[meigface] could not maximize window: {err}");
                }
                // On Linux the embedded WebKitGTK webview denies getUserMedia
                // by default; grant audio/video capture here (see fn docs).
                #[cfg(target_os = "linux")]
                enable_linux_media_capture(&window);
            }
            // Open the local session-history database and put it in managed
            // state. A failure here is non-fatal: the rest of the app runs
            // without history and session commands degrade gracefully.
            match crate::agent::Database::open(app.handle()) {
                Ok(db) => {
                    app.manage(db);
                }
                Err(err) => {
                    eprintln!("[meigface] could not open session database: {err}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::llm_suggest_gpu_layers,
            bridge::llm_start,
            bridge::llm_stop,
            bridge::llm_status,
            bridge::llm_chat,
            bridge::stt_start,
            bridge::stt_stop,
            bridge::stt_status,
            bridge::tts_synthesize,
            bridge::list_voices,
            bridge::list_prompts,
            bridge::read_prompt,
            bridge::save_prompt,
            bridge::delete_prompt,
            bridge::list_param_profiles,
            bridge::read_param_profile,
            bridge::save_param_profile,
            bridge::delete_param_profile,
            bridge::list_custom_locales,
            bridge::ensure_voice_dirs,
            bridge::ensure_locale_reference,
            agent::agent_ensure_profile,
            agent::agent_delete_profile,
            agent::agent_record_session,
            agent::agent_set_session_summary,
            agent::agent_profile_stats,
            agent::agent_list_sessions,
            agent::agent_delete_session,
            agent::agent_delete_sessions,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Terminate the llama.cpp sidecar on exit so the server
            // process never outlives the application.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let engines = app_handle.state::<crate::sidecar::Engines>();
                if let Err(err) = engines.llm.stop() {
                    eprintln!("[meigface] failed to stop llm sidecar on exit: {err}");
                }
                if let Err(err) = engines.stt.stop() {
                    eprintln!("[meigface] failed to stop stt sidecar on exit: {err}");
                }
            }
        });
}

/// Guarantee the main window starts maximized.
///
/// `app.windows[].maximized` in tauri.conf.json already requests a maximized
/// window at creation time, which avoids a visible resize flash; that option
/// has been reported not to apply on some platforms, so this acts as a
/// fallback and only maximizes when the window is not already maximized.
///
/// Delegating to the OS is deliberate: unlike a manual position/size, the
/// window manager knows the real work area on every platform — taskbar on any
/// edge or auto-hidden (Windows), menu bar and Dock (macOS), panels (Linux) —
/// and on Windows it also compensates for the invisible resize border that
/// decorated windows extend past their visible edge. The taskbar/dock stays
/// visible, since maximizing is not fullscreen.
fn ensure_maximized(window: &tauri::WebviewWindow) -> Result<(), tauri::Error> {
    if !window.is_maximized()? {
        window.maximize()?;
    }
    Ok(())
}

/// Grant the WebKitGTK webview access to audio/video capture on Linux.
///
/// The embedded WebKitGTK webview denies `getUserMedia` by default because,
/// unlike a full browser, it has no chrome to prompt the user — which is why
/// camera/microphone capture silently fails on Linux while working on
/// Windows/macOS (whose native webviews prompt via the OS). This enables
/// MediaStream and installs a permission handler that grants ONLY audio/video
/// capture requests, denying every other permission kind (geolocation,
/// notifications, …) the app does not use. Auto-granting capture is safe here
/// because the webview only ever loads our own bundled frontend (no remote
/// origins), so nothing untrusted can request it, and the user has already
/// been asked by the app's own permission preflight.
#[cfg(target_os = "linux")]
fn enable_linux_media_capture(window: &tauri::WebviewWindow) {
    use webkit2gtk::{
        glib::prelude::Cast, PermissionRequestExt, SettingsExt,
        UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
    };

    // with_webview runs the closure on the UI thread with the native handle.
    // A failure to obtain it is non-fatal: capture just stays unavailable.
    let result = window.with_webview(|webview| {
        // On Linux `inner()` yields the underlying `webkit2gtk::WebView`.
        let web_view = webview.inner();

        // Enable MediaStream so navigator.mediaDevices / getUserMedia work
        // (WebRTC itself is compiled in on modern WebKitGTK builds).
        if let Some(settings) = WebViewExt::settings(&web_view) {
            settings.set_enable_media_stream(true);
        }

        // Decide each permission request: allow only real capture requests,
        // deny anything else to keep the granted surface minimal.
        web_view.connect_permission_request(|_web_view, request| {
            if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
                if media.is_for_audio_device() || media.is_for_video_device() {
                    request.allow();
                } else {
                    request.deny();
                }
            } else {
                // Non-capture permission (geolocation, notifications, …): denied.
                request.deny();
            }
            true // request handled
        });
    });
    if let Err(err) = result {
        eprintln!("[meigface] could not configure webview media capture: {err}");
    }
}