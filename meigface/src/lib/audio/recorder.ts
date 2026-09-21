/**
 * Microphone capture for the conversational loop.
 *
 * Records a single spoken utterance from the microphone and returns it as a
 * WAV blob (PCM 16-bit, mono) ready to POST to whisper-server's /inference
 * endpoint. Nothing is written to disk: the audio lives in memory only.
 *
 * Capture uses the modern AudioWorklet API (not the deprecated
 * ScriptProcessorNode). The AudioContext is created at 16 kHz, which
 * Chromium-based webviews (WebView2) honour by resampling the device input;
 * the WAV is always encoded with the context's real sample rate, so capture
 * still produces a valid file if a runtime ignores the requested rate
 * (whisper-server resamples server-side when needed).
 *
 * End of speech is detected on the main thread with a simple energy-based
 * voice-activity detector (RMS over short frames): once speech has started, a
 * long-enough trailing silence finalizes the utterance.
 */

import { getPreferredMicrophoneId } from "../mediaDevices";

/** Target capture sample rate: whisper's native rate, minimal data. */
const TARGET_SAMPLE_RATE = 16000;

/** Capture rate requested from the microphone; 48 kHz is native for nearly
 *  every device, so the backend never has to choose from an open range. */
const CAPTURE_SAMPLE_RATE_HINT = 48000;


/** Tuning for capture and voice-activity detection. */
export interface MicRecorderOptions {
  /** RMS level (0..1) below which a frame counts as silence. */
  silenceThreshold?: number;
  /** Trailing silence, in ms, that ends an utterance once speech began. */
  silenceDurationMs?: number;
  /** Minimum voiced duration, in ms, for a capture to count as speech. */
  minSpeechMs?: number;
  /** Hard cap on a single utterance, in ms (safety against runaways). */
  maxDurationMs?: number;
  /** Audio retained before speech is detected, in ms, so a soft word onset
   *  is not clipped (pre-roll / look-back). */
  preRollMs?: number;
  /**
   * Optional callback invoked once per audio frame (~64 ms) with that frame's
   * RMS amplitude, a number in [0, 1] (0 = silence, ~0.1+ = clear speech).
   *
   * Use it to drive a mic-level meter, or to tune `silenceThreshold`:
   * temporarily log the value, e.g. `onLevel: (rms) => console.log(rms.toFixed(3))`,
   * then read the console in two conditions —
   *   1. background noise only (no one speaking, fan running): note the peak;
   *   2. normal speech: note the typical level.
   * Set `silenceThreshold` between the two (a bit above the noise peak): high
   * enough to ignore the fan, low enough to catch a soft word onset. A louder
   * environment needs a higher threshold; a quiet one can go lower.
   */
  onLevel?: (rms: number) => void;
}

/**
 * These are the default values for recorder options. Do not change silenceDurationMs and maxDurationMs here, change it for custom values in
 * conversation.ts file.
*/
const DEFAULTS: Required<Omit<MicRecorderOptions, "onLevel">> = {
  silenceThreshold: 0.012,
  silenceDurationMs: 800,
  minSpeechMs: 300,
  preRollMs: 300,
  maxDurationMs: 15000,
};

/**
 * Worklet processor source. It runs in the AudioWorkletGlobalScope (separate
 * from the bundle), so it is shipped as a string and registered from a blob
 * URL. It buffers the 128-sample render quanta into larger frames and posts
 * each frame (a Float32Array) to the main thread for VAD and accumulation.
 */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~64 ms frames at 16 kHz: responsive enough for VAD, while keeping the
    // main-thread message rate low.
    this._frameSize = 1024;
    this._buffer = new Float32Array(this._frameSize);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset === this._frameSize) {
        // Post a copy so the main thread owns the data.
        this.port.postMessage(this._buffer.slice(0));
        this._offset = 0;
      }
    }
    // Keep the processor alive; no output is written, so it stays silent.
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

/** Root-mean-square amplitude of a frame (0..1). */
function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** Concatenate frames into a single contiguous Float32Array. */
function concatFrames(frames: Float32Array[], totalLength: number): Float32Array {
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/** Encode mono Float32 samples as a 16-bit PCM WAV blob. */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  // RIFF / WAVE header (mono, 16-bit PCM).
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // Convert clamped [-1, 1] floats to signed 16-bit little-endian.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Captures one utterance from the microphone. Construct once and reuse
 * `captureUtterance()` per turn; call `cancel()` to abort an in-progress
 * capture (e.g. a stop button) and release the microphone.
 */
export class MicRecorder {
  private readonly options: Required<Omit<MicRecorderOptions, "onLevel">> & {
    onLevel?: MicRecorderOptions["onLevel"];
  };

  // Live capture resources, held only while a capture is running.
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rejectActive: ((reason: Error) => void) | null = null;
  // True while the current capture has detected ongoing speech. Exposed via
  // isSpeaking() so callers can tell a mid-utterance user from an idle listen.
  private userSpeaking = false;

  constructor(options: MicRecorderOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Record until the user stops speaking, then resolve with a WAV blob.
   * Rejects if microphone access fails or `cancel()` is called.
   */
  async captureUtterance(): Promise<Blob> {
    if (this.stream) {
      throw new Error("a capture is already in progress");
    }

    // Prefer the microphone chosen in Settings; fall back to the system
    // default device when none has been picked yet.
    const preferredMicId = await getPreferredMicrophoneId();
    // `sampleRate` is a hint for engines that forward constraints to the
    // capture backend. On WebKitGTK + PipeWire an unconstrained request is
    // negotiated at the bottom of the rate range (1 Hz), which yields a
    // silent stream; naming a real rate lets the backend pick a usable one.
    // `ideal` keeps engines that ignore it (most) unaffected.
    const baseAudio = {
      channelCount: 1,
      sampleRate: { ideal: CAPTURE_SAMPLE_RATE_HINT },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: preferredMicId
          ? { ...baseAudio, deviceId: { exact: preferredMicId } }
          : baseAudio,
      });
    } catch (err) {
      // A saved device ID can go stale (device unplugged, or the engine
      // rotated its per-origin device IDs): `exact` then rejects instead of
      // falling back. Retry with the system default rather than failing the
      // whole capture and leaving the user with a silent, unexplained break.
      if (!preferredMicId) throw err;
      console.warn(
        "[recorder] preferred microphone unavailable, using system default:",
        err,
      );
      stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
    }
    this.stream = stream;

    let sampleRate: number;
    try {
      const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      this.context = context;
      // The real rate the context settled on (may differ if the runtime
      // ignored the request); used for VAD timing and the WAV header.
      sampleRate = context.sampleRate;

      const blobUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
      );
      try {
        await context.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      // The context can start suspended outside a user gesture.
      if (context.state === "suspended") {
        await context.resume();
      }

      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "capture-processor");
      this.source = source;
      this.node = node;
      // source -> node -> destination: the node must reach the destination to
      // be pulled, but it writes no output, so nothing is played back.
      source.connect(node);
      node.connect(context.destination);
    } catch (err) {
      this.teardown();
      throw err;
    }

    const { silenceThreshold, silenceDurationMs, minSpeechMs, maxDurationMs, preRollMs, onLevel } =
      this.options;
    const silenceSamplesLimit = (silenceDurationMs / 1000) * sampleRate;
    const minSpeechSamples = (minSpeechMs / 1000) * sampleRate;
    const maxSamples = (maxDurationMs / 1000) * sampleRate;
    const preRollSamples = (preRollMs / 1000) * sampleRate;

    return new Promise<Blob>((resolve, reject) => {
      let speaking = false;
      let speechSamples = 0;
      let silenceSamples = 0;
      let totalSamples = 0;
      const frames: Float32Array[] = [];
      // Rolling window of recent frames kept while not yet speaking.
      const preRoll: Float32Array[] = [];
      let preRollLength = 0;

      const finalize = () => {
        const samples = concatFrames(frames, totalSamples);
        this.teardown();
        resolve(encodeWavPcm16(samples, sampleRate));
      };

      const reset = () => {
        frames.length = 0;
        totalSamples = 0;
        speechSamples = 0;
        silenceSamples = 0;
        speaking = false;
        preRoll.length = 0;
        preRollLength = 0;
      };

      // Let cancel() abort this capture.
      this.rejectActive = reject;

      this.node!.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const frame = event.data;
        const rms = frameRms(frame);
        onLevel?.(rms);
        const voiced = rms >= silenceThreshold;

        if (!speaking) {
          // Keep a rolling window of the most recent frames (pre-roll) so the
          // quiet onset of the first word is preserved when speech starts.
          preRoll.push(frame);
          preRollLength += frame.length;
          while (preRoll.length > 1 && preRollLength - preRoll[0].length >= preRollSamples) {
            preRollLength -= preRoll.shift()!.length;
          }
          if (voiced) {
            speaking = true;
            this.userSpeaking = true;
            // Prepend the buffered pre-roll (it already includes this frame).
            for (const buffered of preRoll) {
              frames.push(buffered);
              totalSamples += buffered.length;
            }
            speechSamples = frame.length;
            silenceSamples = 0;
            preRoll.length = 0;
            preRollLength = 0;
          }
          return;
        }

        frames.push(frame);
        totalSamples += frame.length;
        if (voiced) {
          speechSamples += frame.length;
          silenceSamples = 0;
        } else {
          silenceSamples += frame.length;
        }

        // A long enough trailing silence ends the utterance...
        if (silenceSamples >= silenceSamplesLimit) {
          if (speechSamples >= minSpeechSamples) {
            finalize();
          } else {
            // ...unless what we caught was too short to be speech (a noise
            // blip): discard it and keep listening.
            reset();
          }
          return;
        }

        // Safety cap on a single utterance.
        if (totalSamples >= maxSamples) {
          finalize();
        }
      };
    });
  }

  /** Abort an in-progress capture and release the microphone. */
  cancel(): void {
    const reject = this.rejectActive;
    this.teardown();
    reject?.(new Error("capture cancelled"));
  }

  /** Stop and release all live capture resources. */
  private teardown(): void {
    this.rejectActive = null;
    this.userSpeaking = false;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context) {
      // Closing is async; ignore the promise (the context is not reused).
      void this.context.close();
      this.context = null;
    }
  }

  /** Whether the in-progress capture has detected ongoing speech. */
  isSpeaking(): boolean {
    return this.userSpeaking;
  }
}