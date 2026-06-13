/**
 * Ensemble pronunciation assessment — two independent ASR engines + LLM judge.
 *
 * Previous approach (Azure Pronunciation Assessment alone, in various modes)
 * proved unreliable: free-speech mode scores ~100 for anything it recognises,
 * and reference mode is partially circular because the reference comes from
 * the same recognition stack. This route replaces the single-engine score
 * with TRIANGULATION:
 *
 *   1. Deepgram nova-3 (prerecorded REST) — an independent engine that
 *      transcribes closer to what was acoustically said, with per-word
 *      confidence. A mispronounced word shows up as a DIFFERENT word or a
 *      low-confidence word here.
 *   2. Azure free-speech assessment — kept as a second, acoustic signal:
 *      per-word accuracy + phoneme scores + error flags.
 *   3. Claude as judge — receives the live transcript (what the UI shows),
 *      both engines' evidence, and the examiner's question, then rates each
 *      word the way a human examiner would: engines agree + high confidence
 *      → good; engines disagree on a word ("think" vs "sink") → work out the
 *      intended word from context and rate the substitution.
 *
 * Fallbacks: if the judge or Deepgram fail, the Azure acoustic result is
 * returned (worst case = previous behaviour, never worse).
 *
 * AZURE_SPEECH_KEY, DEEPGRAM_API_KEY, ANTHROPIC_API_KEY never leave the server.
 */

import Anthropic from "@anthropic-ai/sdk";
import { discreteWordConfidence, wordAccuracy } from "@/lib/pronunciation-scoring";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Evidence collectors ──────────────────────────────────────────────────────

interface DgEvidence {
  transcript: string;
  words: Array<{ word: string; confidence: number }>;
}

/** Independent verbatim hearing of the audio via Deepgram's prerecorded API. */
async function deepgramVerbatim(
  audio: ArrayBuffer,
  contentType: string,
  langCode: string,
): Promise<DgEvidence | null> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return null;
  const lang = langCode === "fr" ? "fr" : langCode === "nl-BE" ? "nl" : "en-US";
  try {
    const res = await fetch(
      `https://api.deepgram.com/v1/listen?model=nova-3&language=${lang}&punctuate=false&smart_format=false`,
      {
        method: "POST",
        headers: { Authorization: `Token ${key}`, "Content-Type": contentType },
        body: audio,
      }
    );
    if (!res.ok) {
      console.warn(`[pronunciation] deepgram ${res.status}: ${(await res.text()).slice(0, 150)}`);
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    const alt = data.results?.channels?.[0]?.alternatives?.[0];
    if (!alt?.transcript?.trim()) return null;
    return {
      transcript: alt.transcript as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      words: (alt.words ?? []).map((w: any) => ({
        word: w.word as string,
        confidence: Math.round((w.confidence ?? 0) * 100) / 100,
      })),
    };
  } catch (e) {
    console.warn("[pronunciation] deepgram failed:", e);
    return null;
  }
}

interface AzWord {
  word: string;
  accuracyScore: number;
  errorType: string;
}

interface AzEvidence {
  text: string;
  words: AzWord[];
  durationSec: number;
}

/** Azure free-speech pronunciation assessment — acoustic per-word scores. */
async function azureAcoustic(
  audio: ArrayBuffer,
  contentType: string,
  langCode: string,
  key: string,
  region: string,
): Promise<AzEvidence | null> {
  const langMap: Record<string, string> = { fr: "fr-FR", en: "en-US", "nl-BE": "nl-BE" };
  const pronConfigB64 = Buffer.from(
    JSON.stringify({ ReferenceText: "", GradingSystem: "HundredMark", Granularity: "Phoneme", EnableMiscue: false })
  ).toString("base64");

  try {
    const res = await fetch(
      `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
        `?language=${langMap[langCode] ?? "fr-FR"}&format=detailed`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": contentType,
          "Pronunciation-Assessment": pronConfigB64,
        },
        body: audio,
      }
    );
    if (!res.ok) {
      console.warn(`[pronunciation] azure ${res.status}: ${(await res.text()).slice(0, 150)}`);
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    if (data.RecognitionStatus !== "Success" || !data.NBest?.[0]) {
      console.warn(`[pronunciation] azure no-speech: ${data.RecognitionStatus}`);
      return null;
    }
    const best = data.NBest[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const words: AzWord[] = (best.Words ?? []).map((w: any) => {
      const acc = Math.round(w.PronunciationAssessment?.AccuracyScore ?? 100);
      const errType = w.PronunciationAssessment?.ErrorType ?? "None";
      const accuracy = wordAccuracy(
        acc,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (w.Phonemes ?? []).map((p: any) => p.PronunciationAssessment?.AccuracyScore ?? 100),
        errType
      );
      return { word: w.Word ?? "", accuracyScore: accuracy, errorType: errType };
    });
    return {
      text: best.Display ?? "",
      words,
      durationSec: (data.Duration ?? 0) / 10_000_000,
    };
  } catch (e) {
    console.warn("[pronunciation] azure failed:", e);
    return null;
  }
}

// ─── The judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are an expert phonetician assessing the pronunciation of a second-language learner.

You cannot hear the audio. You receive evidence from two independent speech-recognition engines that both processed the SAME recording, and you triangulate:

1. LIVE transcript — what the conversation recognizer understood. These are the words you must rate, in order.
2. VERBATIM transcript (independent engine) — a second engine's hearing of the same audio, with per-word confidence 0-1. It transcribes closer to what was acoustically said.
3. ACOUSTIC scores — per-word pronunciation accuracy 0-100 and error flags from a pronunciation model.
4. The examiner's question — for inferring which words the learner intended.

Two signals carry different meaning. CROSS-ENGINE AGREEMENT tells you whether the word was RECOGNIZABLE (right word vs. a mispronunciation that changed the word). The ACOUSTIC score, within an agreed word, tells you HOW NATIVE-LIKE it sounded — this is what separates a near-native speaker from a heavily-accented one, and you MUST let it spread the scores. Do not compress everyone into the middle: reward near-native pronunciation at the top, mark strong non-native accents down even when the word is understood.

How to reason, word by word:
- Engines AGREE on the word AND acoustic ≥ 82 (or, if acoustic is unavailable, verbatim confidence ≥ 0.9) → "good". Near-native, crisp.
- Engines AGREE but acoustic 62-82 → "ok". Clear, understandable, but a real non-native accent is present. This is the honest verdict for most learners — use it freely.
- Engines AGREE but acoustic < 62 → "off". The word was understood yet pronounced with a strong, distracting accent. THIS IS THE STRICTNESS THE EXAMINER WANTS — a recognizable word is not automatically a well-pronounced one.
- The verbatim engine's confidence runs conservative: short function words (the, a, of, de, le, et, een, de) often score 0.6-0.8 even from native speakers. Use the ACOUSTIC score, not confidence, to judge accent strength on agreed words; only fall back to confidence when acoustic is missing.
- Engines heard DIFFERENT words at the same position (live "think" / verbatim "sink", or vice versa): real mispronunciation that changed the word. Substitutions (think/sink, live/leave, ship/sheep) are "bad"; use "off" only when the intended word is still obvious despite the distortion. Ignore trivial transcription variants (casing, hyphenation, number formatting, contractions) — those are not disagreements.
- A word missing from the verbatim transcript entirely or weak on every signal → "bad".
- Grammar mistakes are NOT pronunciation mistakes. Rate only HOW words were pronounced.

Calibration for turn_score — use the FULL range, do not cluster:
- Near-native turn (most words "good", acoustic mostly ≥ 85, no disagreement): 90-100. Be generous here — excellent pronunciation should clearly read as excellent.
- Clear but accented (mostly "ok"): 68-82.
- Noticeable non-native accent across the turn (several "off" from low acoustic on agreed words): 50-65. Accent strength alone, with no word-changing errors, can legitimately land here.
- Word-changing errors cost on top of accent: ONE such error caps the turn at 65; two at 50; three or more at 40; mostly garbled below 30.
Let acoustic scores genuinely move the number both ways — high earns the top, low pulls down.

Return ONLY JSON, no markdown fences:
{"turn_score": <0-100 integer>, "words": [{"w": "<word>", "v": "good|ok|off|bad"}], "summary": "<one short sentence on the main issues, or empty>"}
The "words" array must contain EXACTLY one entry per word of the LIVE transcript, in the same order, using the same words.`;

interface JudgeWord {
  w: string;
  v: "good" | "ok" | "off" | "bad";
}

interface JudgeResult {
  turn_score: number;
  words: JudgeWord[];
  summary?: string;
}

async function judge(
  liveTranscript: string,
  langLabel: string,
  context: string,
  dg: DgEvidence | null,
  az: AzEvidence | null,
): Promise<JudgeResult | null> {
  const evidence =
    `Language: ${langLabel}\n` +
    (context ? `Examiner's question: "${context}"\n` : "") +
    `\nLIVE transcript (rate these words, in order):\n"${liveTranscript}"\n` +
    (dg
      ? `\nVERBATIM transcript (independent engine):\n"${dg.transcript}"\nPer-word confidence: ${dg.words.map((w) => `${w.word}(${w.confidence})`).join(" ")}\n`
      : "\nVERBATIM transcript: unavailable\n") +
    (az
      ? `\nACOUSTIC scores: ${az.words.map((w) => `${w.word}(${w.accuracyScore}${w.errorType !== "None" ? "," + w.errorType : ""})`).join(" ")}\n`
      : "\nACOUSTIC scores: unavailable\n");

  try {
    const res = await anthropic.messages.create({
      model: process.env.ANTHROPIC_PRONUNCIATION_MODEL ?? "claude-opus-4-8",
      max_tokens: 2000,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: evidence }],
    });
    const text = (res.content[0]?.type === "text" ? res.content[0].text : "").trim();
    const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as JudgeResult;
    if (typeof parsed.turn_score !== "number" || !Array.isArray(parsed.words)) return null;
    return parsed;
  } catch (e) {
    console.warn("[pronunciation] judge failed:", e);
    return null;
  }
}

// Verdict → display mapping (confidence buckets match wordColor() in page.tsx).
// Deliberately harsh: flagged words cost real points so the turn average drops
// visibly when errors are present.
// Wider spread so accent strength shows: near-native "good" reaches the green
// ceiling, strong-accent "off" drops into orange/red. "ok" is the honest
// middle for clear-but-accented speech.
const VERDICT_MAP: Record<string, { confidence: number; accuracyScore: number; errorType: string }> = {
  good: { confidence: 1.0,  accuracyScore: 96, errorType: "None" },
  ok:   { confidence: 0.7,  accuracyScore: 72, errorType: "None" },
  off:  { confidence: 0.45, accuracyScore: 42, errorType: "Mispronunciation" },
  bad:  { confidence: 0.2,  accuracyScore: 16, errorType: "Mispronunciation" },
};

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION ?? "westeurope";
  if (!key) return new Response("AZURE_SPEECH_KEY missing", { status: 500 });

  const formData = await req.formData();
  const audio = formData.get("audio") as Blob | null;
  const langCode = (formData.get("language") as string | null) ?? "fr";
  const clientWpm = parseInt((formData.get("wpm") as string | null) ?? "0", 10);
  // Live transcript of this turn (the words shown in the UI).
  const referenceText = (formData.get("referenceText") as string | null) ?? "";
  // The examiner's question the learner was answering.
  const context = (formData.get("context") as string | null) ?? "";

  if (!audio || audio.size === 0) return new Response("No audio", { status: 400 });

  const rawType = audio.type ?? "";
  const contentType = rawType.includes("wav")
    ? "audio/wav; codecs=audio/pcm; samplerate=16000"
    : rawType.startsWith("audio/mp4")
    ? "audio/mp4"
    : "audio/webm;codecs=opus";

  const langLabel =
    langCode === "fr" ? "French" :
    langCode === "nl-BE" ? "Dutch (Belgian)" :
    "English";

  console.log(`[pronunciation] blob=${audio.size}B type=${rawType} lang=${langCode} live="${referenceText.slice(0, 50)}"`);

  const audioBuf = await audio.arrayBuffer();

  // Both engines hear the audio in parallel — independent evidence.
  const [dg, az] = await Promise.all([
    deepgramVerbatim(audioBuf, contentType, langCode),
    azureAcoustic(audioBuf, contentType, langCode, key, region),
  ]);

  console.log(
    `[pronunciation] evidence: deepgram=${dg ? `"${dg.transcript.slice(0, 50)}"` : "none"} azure=${az ? `${az.words.length} words` : "none"}`
  );

  const liveText = referenceText || az?.text || dg?.transcript || "";
  if (!liveText.trim()) return Response.json(null);

  // WPM: prefer Azure's measured duration, fall back to the client figure.
  const liveWords = liveText.trim().split(/\s+/).filter(Boolean);
  const wpm =
    az && az.durationSec > 0.5 && liveWords.length >= 6
      ? Math.round((liveWords.length / az.durationSec) * 60)
      : clientWpm;

  // The judge triangulates. If it fails, fall back to the Azure acoustic
  // result (= previous behaviour), so this can only improve on the old path.
  const verdict = await judge(liveText, langLabel, context, dg, az);

  if (verdict) {
    // Defensive alignment: one entry per live-transcript word, in order.
    const words = liveWords.map((w, i) => {
      const v = verdict.words[i]?.v ?? "ok";
      const m = VERDICT_MAP[v] ?? VERDICT_MAP.ok;
      return { word: w, confidence: m.confidence, accuracyScore: m.accuracyScore, errorType: m.errorType };
    });
    // Consistency guard: the turn score can never exceed the average implied
    // by the judge's own per-word verdicts. Stops the judge from flagging
    // three words and still awarding 85 for the turn.
    const wordAvg = words.length
      ? Math.round(words.reduce((s, w) => s + w.accuracyScore, 0) / words.length)
      : 0;
    const score = Math.max(0, Math.min(100, Math.round(verdict.turn_score), wordAvg));
    console.log(
      `[pronunciation] judge OK score=${score} verdicts=${verdict.words.map((w) => `${w.w}:${w.v}`).join(" ")}${verdict.summary ? ` — ${verdict.summary}` : ""}`
    );
    return Response.json({
      text: liveText,
      pronunciationScore: score,
      accuracyScore: score,
      wpm,
      words,
      source: "azure",
    });
  }

  // Fallback: Azure acoustic only.
  if (az) {
    const words = az.words.map((w) => ({
      word: w.word,
      confidence: discreteWordConfidence(w.accuracyScore, w.errorType),
      accuracyScore: w.accuracyScore,
      errorType: w.errorType,
    }));
    const score = words.length
      ? Math.round(words.reduce((s, w) => s + w.accuracyScore, 0) / words.length)
      : 0;
    console.log(`[pronunciation] fallback (azure acoustic) score=${score}`);
    return Response.json({
      text: az.text,
      pronunciationScore: score,
      accuracyScore: score,
      wpm,
      words,
      source: "azure",
    });
  }

  console.warn("[pronunciation] no evidence available — returning null");
  return Response.json(null);
}
