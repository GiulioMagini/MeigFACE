/**
 * Speech playback with mouth animation for the avatar.
 *
 * Plays synthesized speech (the WAV bytes returned by the `tts_synthesize`
 * command) and, while it plays, reports a normalized "mouth openness" in
 * [0, 1] derived from the live audio amplitude, so the caller can drive the
 * avatar's mouth in sync. The player only emits the number; mapping it to the
 * SVG mouth is the avatar's responsibility.
 *
 * The amplitude is read per animation frame from an AnalyserNode placed
 * between the source and the output, so the audio is heard and measured at
 * once. `play()` resolves when playback finishes (or is stopped).
 */

/** Tuning for playback and the mouth signal. */
export interface SpeechPlayerOptions {
  /** Multiplier from RMS amplitude to mouth openness before clamping to 1. */
  gain?: number;
  /** Smoothing in [0, 1] (higher = snappier, lower = smoother). */
  smoothing?: number;
  /** Called once per animation frame with the mouth openness in [0, 1]. */
  onMouth?: (openness: number) => void;
}

const DEFAULTS: Required<Omit<SpeechPlayerOptions, "onMouth">> = {
  gain: 8,
  smoothing: 0.4,
};

/**
 * Normalize the payload returned by `invoke("tts_synthesize")` into a fresh
 * ArrayBuffer. In development the Tauri IPC yields an ArrayBuffer, but a
 * packaged build can deliver the raw `Response` bytes as a typed array or a
 * number[]; decodeAudioData requires an ArrayBuffer, so coerce every case here.
 */
export function toArrayBuffer(
  data: ArrayBuffer | ArrayBufferView | number[],
): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : Uint8Array.from(data);
  // Copy into a standalone ArrayBuffer (decodeAudioData will detach this copy).
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export class SpeechPlayer {
  private readonly options: Required<Omit<SpeechPlayerOptions, "onMouth">> & {
    onMouth?: SpeechPlayerOptions["onMouth"];
  };

  // The context is created once and reused across utterances.
  private context: AudioContext | null = null;
  // The currently playing source, and a stopper that ends it early.
  private source: AudioBufferSourceNode | null = null;
  private stopCurrent: (() => void) | null = null;

  constructor(options: SpeechPlayerOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Decode and play WAV bytes, animating the mouth via `onMouth`. Resolves
   * when playback ends naturally or is stopped. Intended for sequential use
   * (await one utterance before playing the next).
   */
  async play(wav: ArrayBuffer | ArrayBufferView | number[]): Promise<void> {
    // End any utterance still playing before starting a new one.
    this.stop();

    const context = this.context ?? new AudioContext();
    this.context = context;
    if (context.state === "suspended") {
      await context.resume();
    }

    // toArrayBuffer returns a fresh ArrayBuffer (also coercing the raw IPC
    // payload, which may be a typed array or number[] in a packaged build), so
    // decodeAudioData detaches that copy and the caller's data stays intact. It
    // also resamples to the context rate, so the voice's native rate
    // (e.g. 22050 Hz) plays correctly.
    const audioBuffer = await context.decodeAudioData(toArrayBuffer(wav));

    const source = context.createBufferSource();
    source.buffer = audioBuffer;

    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const samples = new Float32Array(analyser.fftSize);

    // source -> analyser -> output: heard and measured at the same time.
    source.connect(analyser);
    analyser.connect(context.destination);
    this.source = source;

    const { gain, smoothing, onMouth } = this.options;

    return new Promise<void>((resolve) => {
      let rafId = 0;
      let openness = 0;
      let done = false;

      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        const target = Math.min(1, rms * gain);
        // Exponential smoothing so the mouth tracks speech without jitter.
        openness += (target - openness) * smoothing;
        onMouth?.(openness);
        rafId = requestAnimationFrame(tick);
      };

      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(rafId);
        try {
          source.disconnect();
        } catch {
          // already disconnected
        }
        if (this.source === source) {
          this.source = null;
          this.stopCurrent = null;
        }
        onMouth?.(0); // close the mouth
        resolve();
      };

      // Fires both on natural end and on an explicit stop().
      source.onended = finish;
      this.stopCurrent = () => {
        try {
          source.stop();
        } catch {
          // already stopped; finish() still runs via onended or below
        }
      };

      source.start();
      rafId = requestAnimationFrame(tick);
    });
  }

  /** Stop the current utterance immediately (the mouth closes). */
  stop(): void {
    this.stopCurrent?.();
  }
}