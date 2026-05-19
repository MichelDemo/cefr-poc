/**
 * Records the microphone for the duration of a session.
 * Returns a Blob (webm/opus) on stop().
 * Runs independently of Deepgram and Azure — all three can access the
 * mic simultaneously via separate getUserMedia streams.
 *
 * Quality choices:
 * - echoCancellation / noiseSuppression / autoGainControl all OFF:
 *   these DSP processes distort natural speech and reduce listen-back
 *   quality. The STT engines open their own streams with default
 *   (processed) audio, so transcription is unaffected.
 * - 48 kHz mono: browser maximum; Opus at 128 kbps gives broadcast-
 *   quality speech (vs. ~32 kbps default which sounds narrow).
 */
export class SessionRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,   // preserve natural room acoustics
          noiseSuppression: false,   // don't smear consonants / sibilants
          autoGainControl: false,    // keep consistent, uncompressed levels
          sampleRate: 48000,         // full-bandwidth speech
          channelCount: 1,           // mono — sufficient for voice
        },
        video: false,
      });

      // Prefer Opus (best quality/size ratio for speech).
      // Fall back gracefully on browsers that don't support webm.
      const mimeType =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        audioBitsPerSecond: 128_000, // 128 kbps — broadcast-quality speech
      });
      this.chunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.mediaRecorder.start(2000); // chunk every 2 s
    } catch (e) {
      console.warn("SessionRecorder: could not start", e);
    }
  }

  stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(null);
        return;
      }
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder!.mimeType });
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(blob.size > 0 ? blob : null);
      };
      this.mediaRecorder.stop();
    });
  }
}
