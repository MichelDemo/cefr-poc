"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AzureSTT, type PronunciationResult, type WordScore } from "@/lib/azure-stt";
import { StreamingAudioPlayer } from "@/lib/audio-player";
import { SessionRecorder } from "@/lib/session-recorder";
import { blobToWav16kMono } from "@/lib/audio-wav";
import { getSupabase } from "@/lib/supabase";
import type { LiveAvatarHandle } from "@/components/LiveAvatar";

const Avatar = dynamic(
  () => import("@/components/Avatar").then((m) => m.Avatar),
  { ssr: false }
);

const LiveAvatar = dynamic(
  () => import("@/components/LiveAvatar").then((m) => m.LiveAvatar),
  { ssr: false }
);

const USE_HEYGEN = process.env.NEXT_PUBLIC_HEYGEN_ENABLED === "true";

type Lang = "fr" | "en" | "nl-BE";
type Msg = {
  role: "user" | "assistant";
  content: string;
  pronunciation?: PronunciationResult; // only on user turns
  audioUrl?: string;                   // per-turn recording URL (set after evaluation)
};

interface CefrResult {
  candidate: string;
  language: string;
  level: string;
  score_percent: number;
  confidence: "high" | "medium" | "low";
  dimensions: {
    fluency: number | null;
    vocabulary_grammar: number | null;
    communication: number | null;
  };
  strengths: string[];
  areas_for_improvement: string[];
  notable_errors: string[];
  summary: string;
}

// ─── colour helpers ──────────────────────────────────────────────────────────

function wordColor(score: number): string {
  if (score >= 80) return "#4ade80";
  if (score >= 60) return "#facc15";
  if (score >= 40) return "#fb923c";
  return "#f87171";
}

function scoreBarColor(score: number): string {
  if (score >= 80) return "#4ade80";
  if (score >= 60) return "#facc15";
  return "#fb923c";
}

// deflateAzure removed: the 1.4×raw−40 calibration was tuned for free-speech
// mode, which clustered all scores in 75-95. Pass-2 reference-mode scoring
// (ReferenceText + EnableMiscue) is already discriminative — deflating it on
// top double-penalised learners (raw 75 displayed as 65).

/** Derive CEFR level from composite score (5-point bands). */
function scoreToLevel(score: number): string {
  if (score >= 90) return "C2";
  if (score >= 85) return "C1+";
  if (score >= 80) return "C1";
  if (score >= 75) return "B2+";
  if (score >= 70) return "B2";
  if (score >= 65) return "B1+";
  if (score >= 60) return "B1";
  if (score >= 55) return "A2+";
  if (score >= 50) return "A2";
  if (score >= 45) return "A1+";
  if (score >= 40) return "A1";
  return "A0";
}

// ─── small reusable bar ───────────────────────────────────────────────────────

function Bar({
  label,
  value,
  max = 100,
}: {
  label: string;
  value: number;
  max?: number;
}) {
  const pct = Math.round((value / max) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 3 }}>
      <span style={{ width: 80, color: "#9ca3af", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 5, background: "rgba(0,0,0,0.35)", borderRadius: 3 }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: scoreBarColor(pct),
            borderRadius: 3,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      <span style={{ width: 28, textAlign: "right", color: "#e5e7eb" }}>{Math.round(value)}</span>
    </div>
  );
}

// ─── Azure averages (still feeds the CEFR panel + evaluation context) ─────────

interface AzureAvg {
  pronunciation: number;
  wpm: number;
  score: number;
  count: number;
  /** Turns with < 6 words — each deducts 0.5 from the fluency dimension. */
  shortTurns: number;
}

// ─── Claude CEFR panel ────────────────────────────────────────────────────────

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "#4ade80",
  medium: "#facc15",
  low: "#fb923c",
};

function CefrPanel({ result, azureAvg }: { result: CefrResult; azureAvg: AzureAvg | null }) {
  // All 4 components on a 0-10 scale for uniform bar display
  const pronScore  = azureAvg  ? azureAvg.pronunciation / 10 : null;
  const fluency    = result.dimensions.fluency;
  const vocabGram  = result.dimensions.vocabulary_grammar;
  const comm       = result.dimensions.communication;

  // Use Claude's score and level directly — the evaluator already accounts for all
  // dimensions holistically.
  const baseScore = result.score_percent;

  // Excellence bonus: when at least 2 of the 4 criteria reach 9/10, pull the
  // overall score up by 5%. Two standout dimensions signal a stronger candidate
  // than a flat profile at the same average — reward that. Counts 9 and 10.
  const highCount = [pronScore, fluency, vocabGram, comm].filter(
    (v): v is number => v !== null && v >= 9
  ).length;
  const compositeScore = highCount >= 2
    ? Math.min(100, Math.round(baseScore * 1.05))
    : baseScore;
  // Recompute the level from the boosted score so the label and number agree.
  const compositeLevel = compositeScore !== baseScore
    ? scoreToLevel(compositeScore)
    : (result.level ?? scoreToLevel(compositeScore));

  const dim4: [string, number | null][] = [
    ["Pronunciation", pronScore],
    ["Fluency",       fluency],
    ["Vocab & Gram.", vocabGram],
    ["Communication", comm],
  ];

  return (
    <div
      style={{
        padding: 12,
        background: "linear-gradient(135deg, #1e3a8a 0%, #4f46e5 100%)",
        borderRadius: 8,
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", fontWeight: 700, letterSpacing: 1 }}>
            ORAL ASSESSMENT
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1.1 }}>{compositeLevel}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
            Score {compositeScore}/100
          </div>
        </div>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 10,
            fontSize: 10,
            fontWeight: 700,
            background: CONFIDENCE_COLOR[result.confidence] ?? "#9ca3af",
            color: "#000",
            marginTop: 4,
          }}
        >
          {result.confidence.toUpperCase()}
        </span>
      </div>

      {/* 4 equal-weight dimension bars (all 0-10) */}
      <div style={{ marginBottom: 8 }}>
        {dim4.map(([label, val]) =>
          val !== null ? (
            <Bar key={label} label={label} value={val} max={10} />
          ) : (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 3 }}>
              <span style={{ width: 80, color: "#9ca3af", flexShrink: 0 }}>{label}</span>
              <span style={{ color: "#4b5563", fontSize: 10 }}>n/a</span>
            </div>
          )
        )}
      </div>

      {/* Strengths */}
      {result.strengths?.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>Strengths</div>
          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11, lineHeight: 1.5 }}>
            {result.strengths.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {/* Areas for improvement */}
      {result.areas_for_improvement?.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>To improve</div>
          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11, lineHeight: 1.5 }}>
            {result.areas_for_improvement.slice(0, 2).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {/* Notable errors */}
      {result.notable_errors?.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>Notable errors</div>
          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11, lineHeight: 1.5, color: "#fca5a5" }}>
            {result.notable_errors.slice(0, 2).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {/* Summary */}
      {result.summary && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.5, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 6 }}>
          {result.summary}
        </div>
      )}
    </div>
  );
}

// ─── Utterance mini-badges ────────────────────────────────────────────────────

function UtteranceBadges({ p }: { p: PronunciationResult }) {
  const dims: [string, number, string][] = [
    ["P", p.pronunciationScore, "Pronunciation confidence"],
    ["W", p.wpm, "Words per minute"],
  ];
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
      {dims.map(([lbl, val, title]) => (
        <span
          key={lbl}
          title={`${title}: ${Math.round(val)}/100`}
          style={{
            background: wordColor(val),
            color: "#000",
            borderRadius: 3,
            padding: "1px 5px",
            fontSize: 10,
            fontWeight: 700,
            cursor: "help",
          }}
        >
          {lbl}
          {Math.round(val)}
        </span>
      ))}
      {/* Source badge: DG = Deepgram confidence proxy (pending Azure), AZ = Azure phoneme scores */}
      <span
        title={
          p.source === "azure"
            ? "Scored by Azure Pronunciation Assessment (phoneme-level)"
            : "Scored by Deepgram confidence — Azure assessment pending"
        }
        style={{
          background: p.source === "azure" ? "#60a5fa" : "#475569",
          color: p.source === "azure" ? "#000" : "#cbd5e1",
          borderRadius: 3,
          padding: "1px 5px",
          fontSize: 10,
          fontWeight: 700,
          cursor: "help",
        }}
      >
        {p.source === "azure" ? "AZ" : "DG"}
      </span>
    </div>
  );
}

// ─── Word-annotated user message ──────────────────────────────────────────────

function UserWords({ words }: { words: WordScore[] }) {
  if (!words.length) return null;
  return (
    <>
      {words.map((w, i) => {
        const pct = Math.round(w.confidence * 100);
        const label = pct >= 80 ? "correct" : pct >= 60 ? "acceptable" : pct >= 35 ? "mispronounced" : "incorrect";
        return (
          <span
            key={i}
            title={`${w.word}: ${label}`}
            style={{
              color: wordColor(pct),
              marginRight: 4,
              cursor: "help",
              textDecoration: w.confidence < 0.7 ? "underline dotted" : "none",
            }}
          >
            {w.word}
          </span>
        );
      })}
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Home() {
  const [language, setLanguage] = useState<Lang>("fr");
  const [sessionStarted, setSessionStarted] = useState(false);
  const [history, setHistory] = useState<Msg[]>([]);
  const [partialUser, setPartialUser] = useState("");
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [amplitude, setAmplitude] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [cefrResult, setCefrResult] = useState<CefrResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const audioBlobUrlRef = useRef<string | null>(null);

  const sttRef = useRef<AzureSTT | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const liveAvatarRef = useRef<LiveAvatarHandle | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const sessionSavedRef = useRef(false);
  /** Set at 4 min — causes the next onFinal to trigger __END__ after the user's sentence. */
  const pendingEndRef = useRef(false);
  const endTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<Msg[]>([]);
  historyRef.current = history;
  /** Queue of turns spoken while avatar was responding — processed in order after avatar finishes. */
  const bufferedTurnsRef = useRef<Array<{ text: string; pronunciation: PronunciationResult }>>([]);
  /** Flush function stored in a ref so the amplitude callback can call it without stale closures. */
  const processBufferedRef = useRef<() => void>(() => {});
  /** Per-turn MediaRecorder — one recording per user utterance, restarted after each turn. */
  const turnRecorderRef = useRef<MediaRecorder | null>(null);
  const turnChunksRef = useRef<Blob[]>([]);
  const turnMimeRef = useRef<string>("audio/webm");
  /**
   * Dedicated mic stream for per-turn and session recording.
   * AzureSTT manages its own internal getUserMedia — this stream is for
   * MediaRecorder only, so there is no AudioContext conflict.
   */
  const micStreamRef = useRef<MediaStream | null>(null);

  // Derived: average Azure pronunciation scores across all scored user turns
  const azureAvg = useMemo<AzureAvg | null>(() => {
    const scored = history.filter((m) => m.role === "user" && m.pronunciation);
    if (!scored.length) return null;
    const avg = (key: keyof PronunciationResult) => {
      const vals = scored.map((m) => m.pronunciation![key] as number);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const pronunciation = avg("pronunciationScore");
    // Only average WPM over long turns (≥ 6 words); short answers return wpm=0
    // and would drag the fluency figure below the real speaking rate.
    const wpmTurns = scored.filter((m) => (m.pronunciation!.wpm ?? 0) > 0);
    const wpm = wpmTurns.length > 0
      ? wpmTurns.reduce((s, m) => s + m.pronunciation!.wpm, 0) / wpmTurns.length
      : 0;
    const score = Math.round(pronunciation);
    const shortTurns = scored.filter((m) => (m.pronunciation!.wpm ?? 0) === 0).length;
    return {
      pronunciation,
      wpm,
      score,
      count: scored.length,
      shortTurns,
    };
  }, [history]);

  // ── timer ──
  useEffect(() => {
    if (!sessionStarted) return;
    const id = setInterval(() => {
      if (startedAtRef.current)
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [sessionStarted]);

  // Auto-evaluate and close conversation at 3 min.
  // Don't interrupt mid-sentence: set a flag so onFinal triggers __END__
  // after the user finishes speaking. Safety timeout fires after 20 s in
  // case the user is already silent.
  useEffect(() => {
    if (elapsed === 180 && !cefrResult && !evaluating) {
      runEvaluation();
      pendingEndRef.current = true;
      endTimeoutRef.current = setTimeout(() => {
        if (pendingEndRef.current) {
          pendingEndRef.current = false;
          handleUserTurn("__END__");
        }
      }, 20_000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  // ── save session to Supabase ──
  const saveSession = async (audioBlob: Blob | null, result?: typeof cefrResult) => {
    if (sessionSavedRef.current) return;
    sessionSavedRef.current = true;

    let audioUrl: string | null = null;

    if (audioBlob && audioBlob.size > 0) {
      const ext = audioBlob.type.includes("ogg") ? "ogg" : "webm";
      const sessionId = crypto.randomUUID();
      const path = `${language}/${new Date().toISOString().slice(0, 10)}/${sessionId}.${ext}`;
      const { error } = await getSupabase().storage
        .from("recordings")
        .upload(path, audioBlob, { contentType: audioBlob.type });
      if (!error) {
        const { data } = getSupabase().storage.from("recordings").getPublicUrl(path);
        audioUrl = data.publicUrl;
      } else {
        console.error("Audio upload error:", error.message);
      }
    }

    const { error } = await getSupabase().from("sessions").insert({
      language,
      duration_seconds: elapsed,
      cefr_level: result?.level ?? null,
      global_score: result?.score_percent ?? null,
      scores: result?.dimensions ?? null,
      transcript: historyRef.current,
      audio_url: audioUrl,
      azure_scores: azureAvg,
    });
    if (error) console.error("Session save error:", error.message);
  };

  // ── per-turn recorder helpers ──────────────────────────────────────────────
  const startTurnRecording = () => {
    if (turnRecorderRef.current) return; // already recording
    const stream = micStreamRef.current;
    if (!stream) { console.warn("startTurnRecording: mic stream not available"); return; }
    // Pick the best supported mimeType across browsers
    const mimeType =
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" :
      MediaRecorder.isTypeSupported("audio/webm")             ? "audio/webm" :
      MediaRecorder.isTypeSupported("audio/mp4")              ? "audio/mp4" :
      "";
    if (!mimeType) { console.warn("startTurnRecording: no supported mimeType"); return; }
    try {
      turnMimeRef.current = mimeType;
      turnChunksRef.current = [];
      // 256 kbps opus: extra spectral headroom before the 16 kHz downsample in
      // blobToWav16kMono — costs nothing, preserves consonant detail.
      const mr = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 256_000 });
      mr.ondataavailable = (e) => { if (e.data.size > 0) turnChunksRef.current.push(e.data); };
      mr.onerror = (e) => console.error("TurnRecorder error:", e);
      mr.start(500); // collect chunks every 500 ms
      turnRecorderRef.current = mr;
    } catch (e) {
      console.error("startTurnRecording failed:", e);
    }
  };

  const stopTurnRecording = (): Promise<{ blob: Blob } | null> => {
    const mr = turnRecorderRef.current;
    turnRecorderRef.current = null;
    if (!mr || mr.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      mr.onstop = () => {
        const blob = new Blob(turnChunksRef.current, { type: turnMimeRef.current });
        turnChunksRef.current = [];
        if (blob.size === 0) { resolve(null); return; }
        // No object URL here — the transcript player uses the conditioned WAV
        // created in callPronunciationAPI, not the raw webm.
        resolve({ blob });
      };
      mr.stop();
    });
  };

  // ── two-pass pronunciation: REST API with LLM-corrected reference ───────────
  // Pass 1: AzureSTT SDK scores (free-speech mode — lenient, near-100 for any
  //   recognized word) are attached immediately as placeholders.
  // Pass 2 (this function): converts the turn recording to WAV 16 kHz mono
  //   (Azure's REST endpoint rejects Chrome's webm container — the silent
  //   failure that left pass-1's ~100 scores on screen), then sends it with the
  //   transcript + examiner question. The server has Claude reconstruct the
  //   INTENDED text and Azure scores actual phonemes against it
  //   (EnableMiscue:true) — catching substitutions, omissions, insertions.
  //   Result overwrites the pass-1 scores in place.
  const callPronunciationAPI = async (
    blob: Blob,
    turnIndex: number,
    wpm: number,
    referenceText: string,
    context: string,
  ) => {
    let audio = blob;
    let filename = "turn.webm";
    try {
      audio = await blobToWav16kMono(blob);
      filename = "turn.wav";
    } catch (e) {
      // Decode failure — send the original container and let the server try.
      console.warn("[pronunciation] WAV conversion failed, sending raw blob:", e);
    }

    // The transcript's per-turn player gets the CONDITIONED WAV, not the raw
    // webm: the raw track is recorded with AGC off and can be inaudibly quiet,
    // while the WAV is silence-trimmed and peak-normalised — and it is exactly
    // the audio the assessment engines heard, so listening back lets you check
    // the judge's verdicts against the same evidence.
    const playbackUrl = URL.createObjectURL(audio);
    setHistory((h) =>
      h.map((m, i) => (i === turnIndex && m.role === "user" ? { ...m, audioUrl: playbackUrl } : m))
    );

    const form = new FormData();
    form.append("audio", audio, filename);
    form.append("language", language);
    form.append("wpm", String(wpm));
    form.append("referenceText", referenceText);
    // The examiner's question this turn answers — used server-side by the LLM
    // correction step to reconstruct what the learner intended to say.
    form.append("context", context);

    try {
      const r = await fetch("/api/pronunciation", { method: "POST", body: form });
      if (!r.ok) {
        // Loud failure: a dead pass 2 means the lenient pass-1 scores stay on
        // screen — exactly the "everything is 100%" bug. Never fail silently.
        console.error(`[pronunciation] pass-2 HTTP ${r.status}: ${await r.text()}`);
        return;
      }
      const result = (await r.json()) as PronunciationResult | null;
      if (!result) {
        console.warn("[pronunciation] pass-2 returned no result (Azure no-speech)");
        return;
      }
      console.log(`[pronunciation] pass-2 OK turn=${turnIndex} score=${result.pronunciationScore}`);
      setHistory((h) =>
        h.map((m, i) => {
          if (i !== turnIndex || m.role !== "user" || !m.pronunciation) return m;
          return { ...m, pronunciation: { ...result, source: "azure" } };
        })
      );
    } catch (e) {
      console.error("[pronunciation] pass-2 request failed:", e);
    }
  };

  // ── session ──
  const startSession = async () => {
    setSessionStarted(true);
    sessionSavedRef.current = false;
    startedAtRef.current = Date.now();

    // Reset ALL per-session state from any previous run. Without this, a stale
    // cefrResult from the last evaluation keeps the pronunciation panel and
    // coloured transcript words visible during the entire new session (every
    // `cefrResult &&` display gate passes from the first second).
    setCefrResult(null);
    setHistory([]);
    // historyRef is normally synced on render — but handleUserTurn("__START__")
    // below runs before the next render, so clear the ref directly or the new
    // session's first /api/chat call would include the previous transcript.
    historyRef.current = [];
    setPartialUser("");
    setStreamingAssistant("");
    setElapsed(0);
    bufferedTurnsRef.current = [];
    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = null;
    }
    setAudioBlob(null);

    if (!USE_HEYGEN) {
      // Create player and unlock AudioContext NOW — must be synchronous and
      // inside the click handler before any await, otherwise Chrome's autoplay
      // policy will block the AudioContext when the first TTS chunk arrives.
      // The MediaStreamDestinationNode (for session recording) is also created
      // here so it's ready when we connect the mic stream after Deepgram starts.
      playerRef.current = new StreamingAudioPlayer((amp) => {
        const wasSpeaking = isSpeakingRef.current;
        isSpeakingRef.current = amp > 0;
        setAmplitude(amp);
        // When the last audio chunk finishes playing, flush any queued user turns.
        // This is the correct moment — the SSE stream ends before audio finishes,
        // so flushing from the SSE callback would overlap with playback.
        if (wasSpeaking && amp === 0) {
          processBufferedRef.current();
        }
      });
      playerRef.current.init();
    }

    // ── Azure STT: transcription + pronunciation in one step ─────────────────
    sttRef.current = new AzureSTT(language, {
      onPartial: (text) => {
        if (isSpeakingRef.current) return;
        setPartialUser(text);
        if (USE_HEYGEN) liveAvatarRef.current?.startListening();
      },
      onFinal: async (text, azurePron) => {
        if (!text.trim()) return;

        // Azure SDK returns per-phoneme scores directly — no secondary REST call needed.
        const pronunciation: PronunciationResult = { ...azurePron, source: "azure" };

        // Avatar is still talking or processing a previous turn — queue this turn.
        // All queued turns are replayed in order once the avatar finishes speaking.
        if (isProcessingRef.current || isSpeakingRef.current) {
          bufferedTurnsRef.current.push({ text, pronunciation });
          return;
        }

        setPartialUser("");
        if (USE_HEYGEN) liveAvatarRef.current?.stopListening();

        // Stop current turn recorder (captures this utterance's audio),
        // then immediately restart for the next turn.
        const turnIndex = historyRef.current.length;
        const recordingPromise = stopTurnRecording();
        startTurnRecording();

        // Capture and clear the pending-end flag before any await.
        const shouldEnd = pendingEndRef.current;
        if (shouldEnd) {
          pendingEndRef.current = false;
          if (endTimeoutRef.current) {
            clearTimeout(endTimeoutRef.current);
            endTimeoutRef.current = null;
          }
        }

        // The examiner's question this turn answers — captured BEFORE
        // the avatar's next reply is appended to history.
        const questionContext =
          [...historyRef.current].reverse().find((m) => m.role === "assistant")?.content ?? "";

        if (shouldEnd) {
          // Winding down: record + assess this final answer, but do NOT let the
          // avatar ask another question right before closing (that made the
          // ending feel abrupt). Append the user turn to history directly, then
          // go straight to the closing comment, which Claude phrases naturally
          // around the answer it can now see in the transcript.
          const finalHistory: Msg[] = [
            ...historyRef.current,
            { role: "user", content: text, pronunciation },
          ];
          historyRef.current = finalHistory;
          setHistory(finalHistory);
        } else {
          await handleUserTurn(text, pronunciation);
        }

        // Kick off the assessment. callPronunciationAPI also attaches the
        // conditioned WAV to the transcript player (the raw webm is recorded
        // with AGC off and can be inaudibly quiet).
        recordingPromise.then((recording) => {
          if (!recording) return;
          callPronunciationAPI(recording.blob, turnIndex, azurePron.wpm, text, questionContext);
        });

        if (shouldEnd) await handleUserTurn("__END__");
      },
      onError: (e) => console.error("Azure STT error:", e),
    });

    // Open a dedicated mic stream for per-turn recording AND session listen-back.
    // AzureSTT manages its own internal getUserMedia — this stream is used only by
    // MediaRecorder and the player's AudioContext (for mixing), so there is no
    // dual-AudioContext conflict of any kind.
    try {
      // Fidelity-first constraints for the ASSESSMENT stream:
      // - noiseSuppression OFF: browser noise suppression is telephony-grade
      //   and strips broadband fricative energy (/s/ /θ/ /f/ /ʃ/) — exactly
      //   the phonemes pronunciation assessment needs intact.
      // - autoGainControl OFF: AGC pumping distorts phoneme energy; levels are
      //   normalised later in blobToWav16kMono instead.
      // - echoCancellation stays ON: it keeps the avatar's question (playing
      //   through the speakers while the turn recorder runs) out of the clip.
      // Safe because this stream is SEPARATE from AzureSTT's internal mic
      // stream — the live recognizer keeps its own DSP-processed signal, so
      // VAD/segmentation behaviour is unaffected.
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: true,
          noiseSuppression: false,
          channelCount: 1,
          sampleRate: 48000,
        },
        video: false,
      });
      // Mix the mic into the player's session-recording destination so the
      // listen-back audio captures both sides (avatar TTS + user voice).
      // Safe now that AzureSTT owns a completely separate internal stream.
      if (!USE_HEYGEN && playerRef.current) {
        playerRef.current.addMicStream(micStreamRef.current);
      }
    } catch (e) {
      console.warn("Mic stream for recording unavailable:", e);
    }

    // Start Azure STT — failure is non-fatal (avatar TTS still works).
    try {
      await sttRef.current.start();
      startTurnRecording(); // begin recording the first user turn

      if (!USE_HEYGEN && playerRef.current) {
        // Session recording: TTS + mic audio mixed via the player's recordingDest.
        const ttsStream = playerRef.current.getRecordingStream();
        recorderRef.current = new SessionRecorder(ttsStream ?? (micStreamRef.current ?? undefined));
      } else {
        recorderRef.current = new SessionRecorder(micStreamRef.current ?? undefined);
      }
    } catch (e) {
      console.error("Azure STT failed to start:", e);
      recorderRef.current = new SessionRecorder(micStreamRef.current ?? undefined);
    }
    recorderRef.current.start();

    // Kick off the conversation regardless of STT status
    await handleUserTurn("__START__");
  };

  const handleUserTurn = async (userText: string, pronunciation?: PronunciationResult) => {
    isProcessingRef.current = true;
    const isStart = userText === "__START__";
    const isEnd   = userText === "__END__";

    try {
      const newHistory: Msg[] = (isStart || isEnd)
        ? historyRef.current
        : [...historyRef.current, { role: "user", content: userText, pronunciation }];

      if (!isStart && !isEnd) setHistory(newHistory);
      setStreamingAssistant("");

      const userMessage = isStart
        ? language === "fr"
          ? "Bonjour, démarrons la conversation."
          : "Hello, let's start the conversation."
        : isEnd
          ? "__END__"
          : userText;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, history: newHistory, userMessage }),
      });

      if (!res.body) {
        isProcessingRef.current = false;
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const evt of events) {
          const evtMatch = evt.match(/^event: (\w+)/m);
          const dataMatch = evt.match(/^data: (.+)$/m);
          if (!evtMatch || !dataMatch) continue;

          const type = evtMatch[1];
          const data = dataMatch[1];

          if (type === "text") {
            const { delta } = JSON.parse(data);
            assistantText += delta;
            setStreamingAssistant(assistantText);
          } else if (type === "audio") {
            if (USE_HEYGEN) {
              liveAvatarRef.current?.sendAudio(data);
            } else {
              playerRef.current?.playChunk(data);
            }
          } else if (type === "done") {
            const { fullText } = JSON.parse(data);
            setHistory((h) => [...h, { role: "assistant", content: fullText }]);
            setStreamingAssistant("");
            if (USE_HEYGEN) liveAvatarRef.current?.speakEnd();
          } else if (type === "error") {
            console.error("Stream error:", data);
          }
        }
      }

      if (!isEnd) {
        isProcessingRef.current = false;
        // Flush buffered turns only if audio has already finished playing.
        // If avatar is still speaking (SSE ended before last chunk played out),
        // the StreamingAudioPlayer amplitude→0 callback will trigger the flush
        // at the correct moment instead.
        processBufferedRef.current();
      }
    } catch (err) {
      // Any network error or malformed JSON in the SSE stream would otherwise
      // leave isProcessingRef permanently true — every subsequent user turn
      // buffers and nothing ever flushes, making the system appear deaf.
      console.error("handleUserTurn failed:", err);
      isProcessingRef.current = false;
      processBufferedRef.current();
    }
  };

  // ── flush function: process the next queued user turn ─────────────────────
  // Stored in a ref so the amplitude callback (which runs outside React's
  // render cycle) always calls the latest version via processBufferedRef.current.
  processBufferedRef.current = async () => {
    if (isProcessingRef.current || isSpeakingRef.current) return;
    const buffered = bufferedTurnsRef.current.shift();
    if (!buffered) return;
    const turnIndex = historyRef.current.length;
    const recordingPromise = stopTurnRecording();
    startTurnRecording();
    // Examiner's question — captured before handleUserTurn appends the reply.
    const questionContext =
      [...historyRef.current].reverse().find((m) => m.role === "assistant")?.content ?? "";
    await handleUserTurn(buffered.text, buffered.pronunciation);
    recordingPromise.then((recording) => {
      if (!recording) return;
      callPronunciationAPI(recording.blob, turnIndex, buffered.pronunciation.wpm ?? 0, buffered.text, questionContext);
    });
  };

  const runEvaluation = async () => {
    setEvaluating(true);

    await stopTurnRecording();
    sttRef.current?.stop();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    const blob = await recorderRef.current?.stop() ?? null;
    if (blob && blob.size > 0) {
      // Revoke previous object URL to avoid memory leaks
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current);
      }
      audioBlobUrlRef.current = URL.createObjectURL(blob);
      setAudioBlob(blob);
    }

    const userTurns = historyRef.current
      .filter((m) => m.role === "user")
      .map((m) => m.content);

    const res = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, userTurns, azureContext: azureAvg }),
    });
    const data = await res.json();
    setCefrResult(data);
    setEvaluating(false);
  };

  const stopSession = async () => {
    pendingEndRef.current = false;
    if (endTimeoutRef.current) {
      clearTimeout(endTimeoutRef.current);
      endTimeoutRef.current = null;
    }
    await stopTurnRecording();
    sttRef.current?.stop();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    // Stop session recorder BEFORE closing the player's AudioContext.
    // The combined stream is sourced from the player's MediaStreamDestinationNode —
    // closing the AudioContext first cuts the stream before the recorder can flush
    // its final buffered chunk. stop() is safe to call twice (returns null if
    // the MediaRecorder was already stopped by runEvaluation).
    const freshBlob = await recorderRef.current?.stop() ?? null;
    if (!USE_HEYGEN) playerRef.current?.stop();
    // Show the listen-back player even when stopping without evaluating.
    if (freshBlob && freshBlob.size > 0) {
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = URL.createObjectURL(freshBlob);
      setAudioBlob(freshBlob);
    }
    await saveSession(freshBlob ?? audioBlob, cefrResult ?? undefined);
    setSessionStarted(false);
  };

  const mm = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const ss = (elapsed % 60).toString().padStart(2, "0");

  return (
    <main style={{ display: "flex", height: "100vh", flexDirection: "column", background: "#0f172a", color: "#f1f5f9" }}>
      {/* ── header ── */}
      <header
        style={{
          padding: "10px 20px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>CEFR Pronunciation POC</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {sessionStarted && (
            <span style={{ fontFamily: "monospace", fontSize: 13, color: elapsed >= 180 ? "#4ade80" : "#94a3b8" }}>
              {mm}:{ss} {elapsed >= 180 ? "✓" : ""}
            </span>
          )}
          {!sessionStarted ? (
            <>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as Lang)}
                style={{ padding: "5px 8px", background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 4 }}
              >
                <option value="fr">Français</option>
                <option value="en">English</option>
                <option value="nl-BE">Nederlands (BE)</option>
              </select>
              <button onClick={startSession} style={btn("#4f46e5")}>
                Démarrer
              </button>
            </>
          ) : (
            <>
              <button onClick={runEvaluation} disabled={evaluating} style={btn("#10b981")}>
                {evaluating ? "Évaluation…" : "Évaluer (Claude)"}
              </button>
              <button onClick={stopSession} style={btn("#ef4444")}>
                Arrêter
              </button>
            </>
          )}
        </div>
      </header>

      {/* ── body ──
          During the session: avatar left + results sidebar right.
          Once the CEFR assessment is in: the avatar section is removed and
          the analysis (panels, listen-back audio, transcript) goes full screen. */}
      <div style={{ display: "grid", gridTemplateColumns: cefrResult ? "1fr" : "1fr 520px", flex: 1, overflow: "hidden" }}>
        {/* Avatar — hidden once the assessment is complete */}
        {!cefrResult && (
          <div style={{ position: "relative", overflow: "hidden" }}>
            {sessionStarted ? (
              USE_HEYGEN ? (
                <LiveAvatar ref={liveAvatarRef} onAmplitude={(amp) => setAmplitude(amp)} />
              ) : (
                <Avatar amplitude={amplitude} />
              )
            ) : (
              <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: "#334155", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 48 }}>🎙️</div>
                <div>Démarre une session pour voir l&apos;avatar</div>
              </div>
            )}
            {/* Overlay: live captions */}
            {sessionStarted && (partialUser || streamingAssistant) && (
              <div
                style={{
                  position: "absolute",
                  bottom: 16,
                  left: 16,
                  right: 16,
                  padding: "10px 14px",
                  background: "rgba(0,0,0,0.72)",
                  borderRadius: 8,
                  backdropFilter: "blur(4px)",
                }}
              >
                {partialUser && (
                  <div style={{ fontStyle: "italic", color: "#94a3b8", fontSize: 14 }}>
                    🎤 {partialUser}
                  </div>
                )}
                {streamingAssistant && (
                  <div style={{ color: "#e2e8f0", fontSize: 14 }}>{streamingAssistant}</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Results panel — sidebar during the session, full screen afterwards */}
        <aside
          style={{
            borderLeft: cefrResult ? "none" : "1px solid #1e293b",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            ...(cefrResult ? { maxWidth: 1100, width: "100%", margin: "0 auto" } : {}),
          }}
        >
          {/* Score panel — shown only once the evaluation completes. The raw
              acoustic panel (QUALITÉ DE PRONONCIATION) was removed: the CEFR
              card already carries the pronunciation dimension, and the raw
              acoustic average duplicated it confusingly. */}
          {cefrResult && (
            <div style={{ padding: 12, borderBottom: "1px solid #1e293b", flexShrink: 0 }}>
              <CefrPanel result={cefrResult} azureAvg={azureAvg} />
            </div>
          )}

          {/* Listen-back player — shown once the recording has been captured */}
          {audioBlob && audioBlobUrlRef.current && (
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #1e293b",
                flexShrink: 0,
                background: "#0f172a",
              }}
            >
              <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
                LISTEN BACK
              </div>
              <audio
                controls
                src={audioBlobUrlRef.current}
                style={{ width: "100%", height: 32, accentColor: "#4f46e5" }}
              />
              <div style={{ fontSize: 10, color: "#475569", marginTop: 4 }}>
                Coloured words in the transcript below show pronunciation quality.
              </div>
            </div>
          )}

          {/* Transcript */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            <div style={{ fontSize: 11, color: "#475569", fontWeight: 700, letterSpacing: 1, marginBottom: 10 }}>
              TRANSCRIPT
            </div>
            {history.length === 0 && (
              <p style={{ color: "#334155", fontSize: 13 }}>La conversation s&apos;affichera ici…</p>
            )}
            {history.map((m, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 10,
                  padding: "8px 10px",
                  background: m.role === "user" ? "#1e293b" : "#1e1b4b",
                  borderRadius: 6,
                  borderLeft: `3px solid ${m.role === "user" ? "#334155" : "#4f46e5"}`,
                }}
              >
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>
                  {m.role === "user" ? "Vous" : "Avatar"}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {/* Coloured pronunciation words appear only after the CEFR
                      evaluation — during the session the transcript stays plain. */}
                  {cefrResult && m.role === "user" && m.pronunciation?.words?.length ? (
                    <UserWords words={m.pronunciation.words} />
                  ) : (
                    m.content
                  )}
                </div>
                {cefrResult && m.role === "user" && m.pronunciation && (
                  <UtteranceBadges p={m.pronunciation} />
                )}
                {m.role === "user" && m.audioUrl && cefrResult && (
                  <audio
                    controls
                    src={m.audioUrl}
                    onError={(e) => {
                      // A bad blob source would otherwise render a broken
                      // player; hide it and log instead of surfacing an error.
                      console.warn(`[playback] turn ${i} audio failed to load`);
                      (e.currentTarget as HTMLAudioElement).style.display = "none";
                    }}
                    style={{ width: "100%", height: 28, marginTop: 6, accentColor: "#4f46e5", display: "block" }}
                  />
                )}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: color,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  };
}
