//! Up-front camera/microphone permission handling.
//!
//! Requesting access at startup makes the OS/WebView2 prompts appear at a calm
//! moment, instead of in the middle of a timed check (e.g. the Whisper "say
//! hi" test), where granting too slowly would make the check fail before the
//! user finished allowing it.

export interface MediaPermissionState {
  camera: boolean;
  microphone: boolean;
}

/// Request a single device and immediately release the obtained stream.
/// Returns whether access was granted.
async function requestDevice(
  constraints: MediaStreamConstraints,
): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // We only wanted the permission; stop the tracks right away.
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

/// Ensure camera and microphone permissions, prompting if needed. Safe to call
/// on every startup: if access is already granted the prompts do not reappear
/// and the streams are released immediately. Mic and camera are requested
/// separately so one denial does not mask the other.
export async function ensureMediaPermissions(): Promise<MediaPermissionState> {
  const microphone = await requestDevice({ audio: true });
  const camera = await requestDevice({ video: true });
  return { camera, microphone };
}

/// Best-effort host-OS detection from the user agent, used only to pick the
/// right "re-enable permissions" hint. Works across the three desktop webviews
/// (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux).
export type OsKind = "windows" | "macos" | "linux" | "other";

export function detectOs(): OsKind {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}