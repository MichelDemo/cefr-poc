/**
 * Browser-side Deepgram streaming STT client.
 * Uses the native WebSocket API — no SDK dependency.
 * Sends raw PCM (linear16 @ 16 kHz) to Deepgram's live transcription endpoint.
 * Auth: API key passed as WebSocket subprotocol (Deepgram's supported browser method).
 *
 * Replaces lib/azure-stt.ts for speech recognition.
 * Azure TTS (avatar speaking voice) is unaffected — it runs server-side.
 *
 * Non-interruption design:
 *   Deepgram emits is_final=true on sentence boundaries (speaker may still be talking).
 *   speech_final=true means Deepgram detected ≥500 ms of silence — the speaker has
 *   genuinely stopped. We accumulate is_final segments and only call onFinal when
 *   speech_final fires, so the avatar never cuts the speaker off mid-sentence.
 */

export interface WordScore {
  word: string;
  /** Deepgram per-word confidence 0–1 */
  confidence: number;
}

export interface PronunciationResult {
  text: string;
  /** Average word confidence × 100 (0–100). Used as pronunciation quality proxy. */
  pronunciationScore: number;
  /** Words per minute — derived from Deepgram word-level timestamps. */
  wpm: number;
  words: WordScore[];
}

export interface SttCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string, pronunciation: PronunciationResult) => void;
  onError?: (err: unknown) => void;
}

// Shape of a word in Deepgram's response
interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
}

export class DeepgramSTT {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private cb: SttCallbacks;
  private language: "fr" | "en" | "nl-BE";

  // Accumulated across is_final segments until speech_final / UtteranceEnd fires
  private pendingTranscript = "";
  private pendingWords: DgWord[] = [];
  /** Fallback timer — dispatches the accumulated utterance if speech_final never arrives. */
  private utteranceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(language: "fr" | "en" | "nl-BE", callbacks: SttCallbacks) {
    this.language = language;
    this.cb = callbacks;
  }

  async start() {
    // Fetch the Deepgram API key from our server endpoint
    const tokenRes = await fetch("/api/deepgram-token");
    if (!tokenRes.ok) throw new Error("Failed to fetch Deepgram token");
    const { key } = (await tokenRes.json()) as { key: string };

    const lang =
      this.language === "fr" ? "fr" :
      this.language === "nl-BE" ? "nl" :
      "en-US";

    const url =
      `wss://api.deepgram.com/v1/listen` +
      `?model=nova-3` +
      `&language=${lang}` +
      `&interim_results=true` +
      `&punctuate=true` +
      `&smart_format=true` +
      `&encoding=linear16` +
      `&sample_rate=16000` +
      // 1500 ms silence before speech_final fires. Non-native speakers often pause
      // 500-1000 ms mid-sentence to find words — 800 ms was too short and caused
      // the avatar to cut in before the speaker finished. 1500 ms gives comfortable
      // room for mid-sentence pauses while still detecting genuine turn-ends.
      `&endpointing=1500` +
      // UtteranceEnd as a safety net only — fired after 3000 ms of silence so it
      // never triggers on natural mid-sentence pauses.
      `&utterance_end_ms=3000`;

    // Deepgram's supported browser auth: API key as WebSocket subprotocol
    this.ws = new WebSocket(url, ["token", key]);
    this.ws.binaryType = "arraybuffer";

    // Wait for the connection to open before starting audio capture.
    // 8-second timeout: if the WebSocket never opens or errors (e.g. firewall
    // silently drops the connection), start() would hang forever and block the
    // avatar from speaking. The caller wraps start() in try/catch.
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        this.ws!.addEventListener("open", () => resolve(), { once: true });
        this.ws!.addEventListener("error", () => reject(new Error("Deepgram WS failed to open")), { once: true });
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Deepgram WS connection timeout (8 s)")), 8000)
      ),
    ]);

    this.ws.addEventListener("message", (e) => this.onMessage(e));
    this.ws.addEventListener("error", () =>
      this.cb.onError?.(new Error("Deepgram WebSocket error"))
    );

    await this.startAudio();
  }

  /**
   * Fires onFinal with the accumulated utterance and resets state.
   * Called by speech_final, UtteranceEnd, and the 2.5 s fallback timer.
   */
  private dispatchUtterance() {
    if (!this.pendingTranscript) return;

    if (this.utteranceTimer) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }

    const fullTranscript = this.pendingTranscript;
    const allWords = this.pendingWords;
    this.pendingTranscript = "";
    this.pendingWords = [];

    const avgConf =
      allWords.length > 0
        ? allWords.reduce((sum, w) => sum + (w.confidence ?? 0), 0) / allWords.length
        : 0;

    // Only calculate WPM for substantive turns (≥ 6 words).
    let wpm = 0;
    if (allWords.length >= 6) {
      const duration = allWords[allWords.length - 1].end - allWords[0].start;
      if (duration >= 0.5) {
        wpm = Math.round((allWords.length / duration) * 60);
      }
    }

    this.cb.onFinal?.(fullTranscript, {
      text: fullTranscript,
      pronunciationScore: Math.round(avgConf * 100),
      wpm,
      words: allWords.map((w) => ({
        word: w.punctuated_word ?? w.word,
        confidence: w.confidence ?? 0,
      })),
    });
  }

  private onMessage(event: MessageEvent) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = JSON.parse(event.data as string) as any;

      // UtteranceEnd: Deepgram detected 1000 ms of silence after the last word.
      // Use it as a fallback trigger when speech_final doesn't fire (background noise).
      if (data.type === "UtteranceEnd") {
        this.dispatchUtterance();
        return;
      }

      if (data.type !== "Results") return;

      const alt = data.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;

      const transcript = alt.transcript as string;

      if (data.is_final) {
        this.pendingTranscript += (this.pendingTranscript ? " " : "") + transcript;
        this.pendingWords.push(...(alt.words ?? []));

        if (data.speech_final) {
          this.dispatchUtterance();
        } else {
          // Set a 5 s fallback: if speech_final never arrives (e.g. noisy environment),
          // dispatch anyway so the conversation doesn't get stuck. 5 s is long enough
          // that it never triggers on mid-sentence pauses (which are ≤ 2 s even for
          // slow speakers) but still prevents the conversation from hanging indefinitely.
          if (this.utteranceTimer) clearTimeout(this.utteranceTimer);
          this.utteranceTimer = setTimeout(() => {
            this.utteranceTimer = null;
            this.dispatchUtterance();
          }, 5000);
        }
      } else {
        // Partial: show accumulated confirmed text + live partial for live caption.
        const display = this.pendingTranscript
          ? this.pendingTranscript + " " + transcript
          : transcript;
        this.cb.onPartial?.(display);
      }
    } catch {
      // Ignore malformed messages (keepalives, metadata)
    }
  }

  /** Expose the mic stream so callers can attach a per-turn MediaRecorder. */
  getStream(): MediaStream | null {
    return this.mediaStream;
  }

  private async startAudio() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.audioContext = new AudioContext({ sampleRate: 16000 });

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // ScriptProcessorNode captures raw PCM from the mic and sends it over WebSocket.
    // Deprecated but universally supported; AudioWorklet would be the modern alternative.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.ws.send(int16.buffer);
    };

    // Connect through a silent gain node so the processor stays active
    // without feeding the mic back to the speakers
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(silentGain);
    silentGain.connect(this.audioContext.destination);
  }

  stop() {
    // Signal Deepgram that no more audio is coming
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    }
    this.ws?.close();
    this.ws = null;

    this.processor?.disconnect();
    this.processor = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    // Cancel pending fallback timer and reset accumulation state
    if (this.utteranceTimer) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
    this.pendingTranscript = "";
    this.pendingWords = [];
  }
}
