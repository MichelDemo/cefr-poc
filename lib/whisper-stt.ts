/**
 * Browser-side Whisper STT client.
 *
 * No WebSocket — uses a local VAD (energy-based silence detection) to
 * determine when the speaker has finished, then sends the accumulated PCM
 * audio to /api/transcribe (server-side OpenAI Whisper call).
 *
 * Trade-offs vs Deepgram streaming:
 *   + Far better transcription accuracy for non-native French / Dutch speakers.
 *   + Word-level timestamps → accurate WPM.
 *   + avg_logprob per segment → pronunciation quality proxy.
 *   - No live partial transcripts (shows "…" while speaking instead).
 *   - ~0.5–2 s extra latency per turn (Whisper API round-trip).
 */

export interface WordScore {
  word: string;
  /** Pseudo-confidence derived from Whisper segment avg_logprob (0–1). */
  confidence: number;
}

export interface PronunciationResult {
  text: string;
  /**
   * Pronunciation quality proxy (0–100).
   * Derived from Whisper segment avg_logprob via cube-root transform on [−1, 0]:
   *   avg_logprob ≥ −0.2  → ~93  (excellent clarity)
   *   avg_logprob ~ −0.4  → ~84  (good non-native browser speech)
   *   avg_logprob ~ −0.6  → ~74  (typical browser mic, correct words)
   *   avg_logprob ~ −0.8  → ~58  (noticeable accent / noise)
   *   avg_logprob ≤ −1.0  → 0    (very unclear)
   */
  pronunciationScore: number;
  /** Words per minute derived from Whisper word-level timestamps. */
  wpm: number;
  words: WordScore[];
}

export interface SttCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string, pronunciation: PronunciationResult) => void;
  onError?: (err: unknown) => void;
}

// ─── Whisper API response shape ───────────────────────────────────────────────

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegment {
  avg_logprob: number;
  no_speech_prob: number;
}

interface WhisperResponse {
  text: string;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
}

// ─── WAV encoder ─────────────────────────────────────────────────────────────

function encodeWAV(chunks: Int16Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);

  const write = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + totalSamples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);      // chunk size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  write(36, "data");
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i], true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ─── Main class ───────────────────────────────────────────────────────────────

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
/** RMS below this level is considered silence. */
const SILENCE_THRESHOLD = 0.008;
/** How long silence must persist before we finalise the turn (ms). */
const SILENCE_MS = 1500;
/** Ignore audio bursts shorter than this — likely background noise (ms). */
const MIN_SPEECH_MS = 400;
/** Whisper segments with no_speech_prob above this are discarded. */
const NO_SPEECH_CUTOFF = 0.6;

export class WhisperSTT {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private cb: SttCallbacks;
  private language: "fr" | "en" | "nl-BE";

  /** True while the speaker is producing sound above the silence threshold. */
  private isSpeaking = false;
  /** Timestamp when the current speech segment started. */
  private speechStartMs = 0;
  /** Accumulated audio for the current utterance. */
  private pendingChunks: Int16Array[] = [];
  /** Timer that fires when silence has persisted long enough. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(language: "fr" | "en" | "nl-BE", callbacks: SttCallbacks) {
    this.language = language;
    this.cb = callbacks;
  }

  async start() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      this.handleAudio(float32);
    };

    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(silentGain);
    silentGain.connect(this.audioContext.destination);
  }

  private handleAudio(float32: Float32Array) {
    // RMS energy of this frame
    const rms = Math.sqrt(float32.reduce((s, v) => s + v * v, 0) / float32.length);

    if (rms > SILENCE_THRESHOLD) {
      // ── Speech frame ──────────────────────────────────────────────────────
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartMs = Date.now();
        this.pendingChunks = [];
        this.cb.onPartial?.("…");
      }
      // Cancel any pending silence timer
      if (this.silenceTimer !== null) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
    } else if (this.isSpeaking) {
      // ── Silence frame while we were speaking ──────────────────────────────
      if (this.silenceTimer === null) {
        this.silenceTimer = setTimeout(() => this.finalize(), SILENCE_MS);
      }
    }

    // Accumulate audio whenever we are (or recently were) speaking
    if (this.isSpeaking) {
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.pendingChunks.push(int16);
    }
  }

  private async finalize() {
    this.silenceTimer = null;

    // Reject very short bursts (noise / cough / etc.)
    if (!this.isSpeaking || Date.now() - this.speechStartMs < MIN_SPEECH_MS) {
      this.isSpeaking = false;
      this.pendingChunks = [];
      this.cb.onPartial?.("");
      return;
    }

    this.isSpeaking = false;
    const chunks = this.pendingChunks;
    this.pendingChunks = [];

    const wav = encodeWAV(chunks, SAMPLE_RATE);
    const fd = new FormData();
    fd.append("audio", wav, "audio.wav");
    fd.append("language", this.language);

    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Transcribe API error ${res.status}`);
      const data = (await res.json()) as WhisperResponse;

      const text = data.text?.trim();
      if (!text) return;

      // Discard if Whisper is confident there was no speech
      const avgNoSpeech =
        data.segments && data.segments.length > 0
          ? data.segments.reduce((s, seg) => s + seg.no_speech_prob, 0) / data.segments.length
          : 0;
      if (avgNoSpeech > NO_SPEECH_CUTOFF) return;

      // Pronunciation score from avg_logprob.
      // Whisper avg_logprob for clear browser-mic speech is typically −0.3 to −0.6.
      // A linear map [−1.2, 0] → [0, 100] would rate correct words at ~50 %.
      // Cube-root transform spreads the upper range so that typical good speech
      // (−0.4 to −0.6) maps to 74–84 % (above the ≥ 70 threshold used by Claude).
      const avgLogprob =
        data.segments && data.segments.length > 0
          ? data.segments.reduce((s, seg) => s + seg.avg_logprob, 0) / data.segments.length
          : -0.5;
      const normalized = Math.max(0, Math.min(1, (avgLogprob + 1.0) / 1.0));
      const pronunciationScore = Math.round(Math.pow(normalized, 1 / 3) * 100);

      // WPM from word timestamps
      const words = data.words ?? [];
      let wpm = 0;
      if (words.length >= 2) {
        const duration = words[words.length - 1].end - words[0].start;
        if (duration >= 0.5) wpm = Math.round((words.length / duration) * 60);
      }

      // Whisper verbose_json provides word timestamps but NO per-word logprob.
      // Spreading the segment score across words gives every word the same
      // fake value (e.g. 79 % when the sentence is clear). Instead: if Whisper
      // transcribed the word, it was pronounced well enough to be understood →
      // treat each transcribed word as fully confident.
      const wordConf = 1.0;

      this.cb.onFinal?.(text, {
        text,
        pronunciationScore,
        wpm,
        words: words.map((w) => ({ word: w.word, confidence: wordConf })),
      });
    } catch (e) {
      this.cb.onError?.(e);
    }
  }

  stop() {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.isSpeaking = false;
    this.pendingChunks = [];

    this.processor?.disconnect();
    this.processor = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
  }
}
