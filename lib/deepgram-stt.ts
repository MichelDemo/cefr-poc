/**
 * Browser-side Deepgram streaming STT client.
 * Uses the native WebSocket API — no SDK dependency.
 * Sends raw PCM (linear16 @ 16 kHz) to Deepgram's live transcription endpoint.
 * Auth: API key passed as WebSocket subprotocol (Deepgram's supported browser method).
 *
 * Replaces lib/azure-stt.ts for speech recognition.
 * Azure TTS (avatar speaking voice) is unaffected — it runs server-side.
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
      `?model=nova-2` +
      `&language=${lang}` +
      `&interim_results=true` +
      `&punctuate=true` +
      `&smart_format=true` +
      `&encoding=linear16` +
      `&sample_rate=16000`;

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

  private onMessage(event: MessageEvent) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = JSON.parse(event.data as string) as any;
      if (data.type !== "Results") return;

      const alt = data.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;

      const transcript = alt.transcript as string;

      if (data.is_final) {
        const words: DgWord[] = alt.words ?? [];

        // Average word confidence → pronunciation quality score
        const avgConf =
          words.length > 0
            ? words.reduce((sum, w) => sum + (w.confidence ?? 0), 0) / words.length
            : (alt.confidence as number ?? 0);

        // WPM from word timestamps (ignore very short segments — likely noise)
        let wpm = 0;
        if (words.length >= 2) {
          const duration = words[words.length - 1].end - words[0].start;
          if (duration >= 0.5) {
            wpm = Math.round((words.length / duration) * 60);
          }
        }

        this.cb.onFinal?.(transcript, {
          text: transcript,
          pronunciationScore: Math.round(avgConf * 100),
          wpm,
          words: words.map((w) => ({
            word: w.punctuated_word ?? w.word,
            confidence: w.confidence ?? 0,
          })),
        });
      } else {
        this.cb.onPartial?.(transcript);
      }
    } catch {
      // Ignore malformed messages (e.g. keepalives)
    }
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
  }
}
