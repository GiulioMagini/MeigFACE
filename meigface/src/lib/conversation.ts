/**
 * Conversational loop orchestrator.
 *
 * Drives the turn-based cycle: listen → transcribe → generate → speak → listen
 * again. Speech-to-text goes straight to whisper-server (the audio is born in
 * the frontend); the reply and its audio go through the Rust backend
 * (`llm_chat`, `tts_synthesize`). The loop is strictly turn-based: while the
 * avatar speaks it does not listen, and listening resumes once it finishes.
 *
 * Conversation history is held here for now; it will move to the backend
 * (persistence + summarization) in a later step.
 */

import { invoke } from "@tauri-apps/api/core";
import { MicRecorder, type MicRecorderOptions } from "./audio/recorder";
import { SpeechPlayer } from "./audio/player";
import { transcribe } from "./audio/transcribe";

/** Hard cap on one transcription request: a hung whisper-server must surface
 *  as a recoverable turn error instead of freezing the session. */
const STT_TIMEOUT_MS = 30_000;

/** Phase the loop is currently in, for UI/avatar feedback. */
export type ConversationState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

/** One message in the conversation, matching the backend's chat shape. */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Per-turn latency, broken down by phase. */
export interface PhaseTiming {
  /** Milliseconds spent transcribing the user's speech. */
  sttMs: number;
  /** Milliseconds spent generating the reply. */
  llmMs: number;
  /** Milliseconds spent synthesizing the reply audio. */
  ttsMs: number;
}

export interface ConversationOptions {
  /** whisper-server base URL (from the `stt_status` command). */
  sttBaseUrl: string;
  /** Absolute path to the Piper executable. */
  piperPath: string;
  /** Spoken language as a locale code (it/en or a custom one); selects the
   *  voices/<code>/ folder and the Whisper language hint. */
  language: string;
  /** Avatar sex, "male" or "female" — selects the Piper voice. */
  gender: string;
  /** Specific Piper voice (.onnx file name). Omitted = first voice for the
   *  language/gender. Matches the voice picked and tested in session setup. */
  voice?: string;
  /** Initial system prompt that sets the assistant's behaviour. */
  systemPrompt: string;
  /** Conversation turns kept in context (older ones are dropped). Default 8. */
  maxHistoryTurns?: number;
  /** LLM sampling temperature (optional). */
  temperature?: number;
  /** LLM reply length cap (optional). */
  maxTokens?: number;
  /** Mouth-openness gain: RMS amplitude multiplier before clamping to 1.
   *  Omitted = the player's default. Wired from the session's mouth-sensitivity
   *  setting so the live avatar matches the setup preview. */
  mouthGain?: number;
  /** Piper speaking-rate multiplier, 1 = the voice's own tuned rate, higher is
   *  faster. Omitted = neutral. Wired from the session's voice-speed setting so
   *  the live conversation matches the setup preview. */
  voiceSpeed?: number;
  /** Microphone/VAD tuning. Defaults here are patient (long pauses and long
   *  utterances allowed), suited to children who take time to finish a phrase. */
  vad?: MicRecorderOptions;

  /** Notified whenever the loop changes phase. */
  onState?: (state: ConversationState) => void;
  /** Forwarded to the player: mouth openness 0..1 while the avatar speaks. */
  onMouth?: (openness: number) => void;
  /** The recognized user text for a turn. */
  onUserText?: (text: string) => void;
  /** The assistant's reply text for a turn. */
  onReply?: (text: string) => void;
  /** Per-phase timings, for latency monitoring. */
  onTiming?: (timing: PhaseTiming) => void;
  /** A recoverable error in a turn; the loop keeps going. */
  onError?: (error: Error) => void;
  /** Fired the instant the scripted closing line starts (before its TTS), so
   *  the host can freeze scoring: the farewell is not part of the exercise.
   *  Normal turns that overran the timer are already counted by this point. */
  onClosing?: () => void;
  /** Fired once the time-up closing line has been spoken and the loop ended. */
  onEnded?: () => void;
}

export class Conversation {
  private readonly options: ConversationOptions & { maxHistoryTurns: number };
  private readonly recorder: MicRecorder;
  private readonly player: SpeechPlayer;
  private messages: ChatMessage[];
  private running = false;
  private currentState: ConversationState = "idle";
  // Time-up handling: when set, the loop finishes the current turn (if any),
  // then speaks `closingText` and reports onEnded.
  private endRequested = false;
  private closingText = "";

  constructor(options: ConversationOptions) {
    this.options = { ...options, maxHistoryTurns: options.maxHistoryTurns ?? 8 };
    const vad: MicRecorderOptions = {
      // Patient defaults for children: a child — especially an autistic child —
      // may pause to think mid-sentence or take a long time to finish. Wait
      // much longer before ending a turn, and allow very long utterances.
      silenceDurationMs: 1000,
      maxDurationMs: 60000,
      ...options.vad,
    };
    this.recorder = new MicRecorder(vad);
    // Pass gain only when configured, so an unset value keeps the player's
    // own default instead of overriding it with undefined.
    this.player = new SpeechPlayer(
      options.mouthGain !== undefined
        ? { onMouth: options.onMouth, gain: options.mouthGain }
        : { onMouth: options.onMouth },
    );
    this.messages = [{ role: "system", content: options.systemPrompt }];
  }

  /** Warm up the LLM, then run the loop until `stop()` is called. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.warmUp();
    void this.loop();
  }

  /** Stop the loop: abort listening and silence the avatar. */
  stop(): void {
    this.running = false;
    this.recorder.cancel();
    this.player.stop();
    this.setState("idle");
  }

  /**
   * Request a graceful end (e.g. the session timer expired). Finishes the
   * current turn — if the user is mid-utterance it is captured and answered
   * first — then the avatar speaks `closingText` and onEnded fires. Idle
   * listening is unblocked immediately so the closing is not delayed.
   */
  requestEnd(closingText: string): void {
    if (!this.running || this.endRequested) return;
    this.endRequested = true;
    this.closingText = closingText;
    if (this.currentState === "listening" && !this.recorder.isSpeaking()) {
      this.recorder.cancel();
    }
  }

  /**
   * Prime the LLM so the first real turn is not slowed by cold start. Sending
   * the system prompt also lets llama-server cache that prefix, speeding up
   * the real turns that follow.
   */
  private async warmUp(): Promise<void> {
    try {
      await invoke<string>("llm_chat", {
        messages: [
          { role: "system", content: this.options.systemPrompt },
          { role: "user", content: "ciao" },
        ],
        maxTokens: 1,
      });
    } catch {
      // A failed warm-up is not fatal; the first turn just pays cold start.
    }
  }

  private async loop(): Promise<void> {
    const { sttBaseUrl, piperPath, language, gender, voice, voiceSpeed, temperature, maxTokens } = this.options;

    while (this.running && !this.endRequested) {
      try {
        // 1. Listen for one utterance.
        this.setState("listening");
        let wav: Blob;
        try {
          wav = await this.recorder.captureUtterance();
        } catch (err) {
          // A cancel triggered by requestEnd() unblocks an idle listen so the
          // closing line is delivered promptly; any other error propagates.
          if (this.endRequested) break;
          throw err;
        }
        if (!this.running) return;

        // 2. Transcribe.
        this.setState("transcribing");
        const sttStart = performance.now();
        const userText = await transcribe(sttBaseUrl, wav, {
          language,
          signal: AbortSignal.timeout(STT_TIMEOUT_MS),
        });
        const sttMs = performance.now() - sttStart;
        if (!this.running) return;
        if (!userText) {
          // Nothing intelligible: listen again without bothering the LLM.
          continue;
        }
        this.options.onUserText?.(userText);

        // 3. Generate the reply.
        this.setState("thinking");
        this.messages.push({ role: "user", content: userText });
        this.trimHistory();
        const llmStart = performance.now();
        const reply = await invoke<string>("llm_chat", {
          messages: this.messages,
          temperature,
          maxTokens,
        });
        const llmMs = performance.now() - llmStart;
        if (!this.running) return;
        this.messages.push({ role: "assistant", content: reply });
        this.options.onReply?.(reply);

        // 4. Synthesize and speak (playback drives the mouth via onMouth).
        this.setState("speaking");
        const ttsStart = performance.now();
        const audio = await invoke<ArrayBuffer>("tts_synthesize", {
          piperPath,
          language,
          gender,
          text: reply,
          voice,
          speed: voiceSpeed,
        });
        const ttsMs = performance.now() - ttsStart;
        if (!this.running) return;
        await this.player.play(audio);

        this.reportTiming({ sttMs, llmMs, ttsMs });
      } catch (error) {
        if (!this.running) return; // a cancel during an await is expected
        if (this.endRequested) break; // ending: skip error handling, go to closing
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
         // Recover: drop back to listening rather than killing the loop.
      }
    }

    // The loop exited on a time-up request (not a hard stop): deliver the
    // scripted closing line, then signal the session has ended.
    if (this.endRequested && this.running) {
      await this.deliverClosing();
    }
  }

  private setState(state: ConversationState): void {
    this.currentState = state;
    this.options.onState?.(state);
  }

  /** Speak the scripted closing line, then mark the session ended. */
  private async deliverClosing(): Promise<void> {
    const { piperPath, language, gender, voice, voiceSpeed } = this.options;
    // Mark the exercise as over before speaking the farewell, so eye contact
    // during the scripted closing line is no longer scored.
    this.options.onClosing?.();
    this.options.onReply?.(this.closingText);
    try {
      this.setState("speaking");
      const audio = await invoke<ArrayBuffer>("tts_synthesize", {
        piperPath,
        language,
        gender,
        text: this.closingText,
        voice,
        speed: voiceSpeed,
      });
      if (this.running) await this.player.play(audio);
    } catch {
      // A failed closing line must not block ending the session.
    }
    this.running = false;
    this.setState("idle");
    this.options.onEnded?.();
  }

  private reportTiming(timing: PhaseTiming): void {
    console.log(
      `[conversation] STT ${timing.sttMs.toFixed(0)} ms | ` +
        `LLM ${timing.llmMs.toFixed(0)} ms | TTS ${timing.ttsMs.toFixed(0)} ms`,
    );
    this.options.onTiming?.(timing);
  }

  /** Keep the system message plus the most recent turns. */
  private trimHistory(): void {
    const max = this.options.maxHistoryTurns * 2; // user + assistant per turn
    if (this.messages.length > max + 1) {
      this.messages = [
        this.messages[0],
        ...this.messages.slice(this.messages.length - max),
      ];
    }
  }
}