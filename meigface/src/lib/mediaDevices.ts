//! Input device enumeration and persisted device preference.
//!
//! `recorder.ts` and `WebcamTracker.svelte` are the only two places that call
//! `getUserMedia`. Both read the preference from here, so every caller
//! (system check, calibration, bias correction, live session) picks up the
//! same chosen microphone/camera automatically, with no prop threading
//! needed through the components that use them.

import { load } from "@tauri-apps/plugin-store";

/** Settings file shared with the rest of the app's persisted preferences. */
const STORE_FILE = "settings.json";

/** Store keys for the chosen input devices, following the "session.*"
 *  naming convention used by the other settings in SessionSetup.svelte. */
const KEY_MICROPHONE = "session.microphoneId";
const KEY_CAMERA = "session.cameraId";

/** One enumerated input device, trimmed to what a picker UI needs. */
export interface InputDevice {
  deviceId: string;
  /** Human-readable name. Empty until the browser has granted this origin
   *  camera/microphone permission (privacy: labels are redacted until then).
   *  The app requests both permissions at startup (see permissions.ts), so
   *  by the time any settings screen runs this is already populated. */
  label: string;
}

/**
 * List available input devices of the given kind. Returns an empty array
 * (rather than throwing) if enumeration is unsupported or fails, so a picker
 * UI can degrade to "no devices found" instead of crashing the settings
 * screen.
 */
export async function listInputDevices(
  kind: "audioinput" | "videoinput",
): Promise<InputDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === kind)
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

/** Read the persisted microphone choice, or null if the system default
 *  should be used (nothing picked yet, or the user cleared the choice). */
export async function getPreferredMicrophoneId(): Promise<string | null> {
  const store = await load(STORE_FILE, { defaults: {}, autoSave: true });
  return (await store.get<string>(KEY_MICROPHONE)) ?? null;
}

/** Persist the chosen microphone. Pass null to clear it and fall back to
 *  the system default device. */
export async function setPreferredMicrophoneId(
  deviceId: string | null,
): Promise<void> {
  const store = await load(STORE_FILE, { defaults: {}, autoSave: true });
  await store.set(KEY_MICROPHONE, deviceId);
}

/** Read the persisted camera choice, or null if the system default should
 *  be used (nothing picked yet, or the user cleared the choice). */
export async function getPreferredCameraId(): Promise<string | null> {
  const store = await load(STORE_FILE, { defaults: {}, autoSave: true });
  return (await store.get<string>(KEY_CAMERA)) ?? null;
}

/** Persist the chosen camera. Pass null to clear it and fall back to the
 *  system default device. */
export async function setPreferredCameraId(
  deviceId: string | null,
): Promise<void> {
  const store = await load(STORE_FILE, { defaults: {}, autoSave: true });
  await store.set(KEY_CAMERA, deviceId);
}