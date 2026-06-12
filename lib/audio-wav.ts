/**
 * Browser-side audio conversion: any MediaRecorder blob → clean WAV 16 kHz
 * mono PCM16, conditioned for pronunciation assessment.
 *
 * Why this exists: Chrome's MediaRecorder produces audio/webm;codecs=opus, but
 * Azure's REST short-audio endpoint only accepts WAV/PCM and OGG/OPUS — WebM is
 * not a supported container. The browser that recorded the blob can always
 * decode it (decodeAudioData handles webm/opus natively).
 *
 * Conditioning steps (all cheap, all offline):
 *   1. High-pass filter at 70 Hz — removes desk/handling rumble and HVAC hum
 *      that pollute the engines' low bands.
 *   2. Resample to 16 kHz mono (what both Deepgram and Azure expect).
 *   3. Trim leading/trailing silence — the clip starts while the avatar is
 *      still asking its question (echo-cancelled to near-silence on the mic
 *      track); cutting it gives the engines a clean utterance with no dead
 *      air, which measurably improves recognition and word timing.
 *   4. Peak normalisation to -0.4 dBFS — the assessment stream records with
 *      autoGainControl off (AGC pumping distorts phoneme energy), so quiet
 *      speakers would otherwise land too low for reliable phoneme scoring.
 */

const TARGET_RATE = 16000;

/** Trim leading/trailing silence, keeping 200 ms of padding on each side. */
function trimSilence(samples: Float32Array, rate: number): Float32Array {
  const frame = Math.round(rate * 0.02); // 20 ms analysis frames
  if (samples.length < frame * 4) return samples;

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return samples; // effectively empty — leave as-is

  // Threshold relative to the clip's own peak, floored to absolute quiet.
  const threshold = Math.max(0.004, peak * 0.05);
  const nFrames = Math.floor(samples.length / frame);
  let first = -1;
  let last = -1;
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / frame) > threshold) {
      if (first === -1) first = f;
      last = f;
    }
  }
  if (first === -1) return samples;

  const pad = Math.round(rate * 0.2);
  const start = Math.max(0, first * frame - pad);
  const end = Math.min(samples.length, (last + 1) * frame + pad);
  return samples.subarray(start, end);
}

/** Scale so the peak sits at ~-0.4 dBFS. Gain capped at 10× to avoid
 *  amplifying a near-silent clip into pure noise. */
function normalize(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return samples;
  const gain = Math.min(0.95 / peak, 10);
  if (Math.abs(gain - 1) < 0.02) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

export async function blobToWav16kMono(blob: Blob): Promise<Blob> {
  const encoded = await blob.arrayBuffer();

  // Decode at the context's native rate, then resample offline.
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(encoded);
  } finally {
    void decodeCtx.close();
  }

  // OfflineAudioContext with 1 channel downmixes and resamples in one pass.
  // The high-pass biquad removes sub-speech rumble before the downsample.
  const frameCount = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frameCount, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  const highpass = offline.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 70;
  source.connect(highpass);
  highpass.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const samples = normalize(trimSilence(rendered.getChannelData(0), TARGET_RATE));

  // 44-byte canonical WAV header + 16-bit little-endian PCM.
  const dataSize = samples.length * 2;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);              // fmt chunk size
  view.setUint16(20, 1, true);               // PCM
  view.setUint16(22, 1, true);               // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);               // block align
  view.setUint16(34, 16, true);              // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([wav], { type: "audio/wav" });
}
