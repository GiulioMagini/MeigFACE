/**
 * Speech-to-text via whisper-server.
 *
 * Sends a recorded utterance (a WAV blob from the microphone recorder) to a
 * running whisper-server instance and returns the transcribed text. The call
 * goes straight from the frontend to the local server: the audio is born here
 * and whisper-server is reachable on loopback, so routing it through the Rust
 * backend would only add an extra copy. whisper-server sends permissive CORS
 * headers, so the webview can read the cross-origin response.
 *
 * `baseUrl` is whisper-server's loopback base (e.g. http://127.0.0.1:8081),
 * obtained from the `stt_status` command's `base_url` field.
 */

/** Options for a transcription request. */
export interface TranscribeOptions {
  /** Spoken language hint, e.g. "it" or "en". Omitted = auto-detect. */
  language?: string;
  /** Sampling temperature. Omitted = server default (0). */
  temperature?: number;
  /** Abort signal, to cancel an in-flight request. */
  signal?: AbortSignal;
}

/** whisper-server's JSON inference response (json response_format). */
interface InferenceResponse {
  text?: string;
}

/**
 * Transcribe one audio clip and return the recognized text (trimmed). An
 * empty string means whisper produced no transcription (e.g. silence).
 *
 * Throws if the request fails or the server returns a non-2xx status.
 */
export async function transcribe(
  baseUrl: string,
  audio: Blob,
  options: TranscribeOptions = {},
): Promise<string> {
  const form = new FormData();
  // The endpoint expects the audio under the "file" field.
  form.append("file", audio, "speech.wav");
  form.append("response_format", "json");
  if (options.language) {
    form.append("language", options.language);
  }
  if (options.temperature !== undefined) {
    form.append("temperature", String(options.temperature));
  }

  // No explicit Content-Type: the browser sets the multipart boundary.
  const response = await fetch(`${baseUrl}/inference`, {
    method: "POST",
    body: form,
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`whisper-server HTTP ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as InferenceResponse;
  return (data.text ?? "").trim();
}