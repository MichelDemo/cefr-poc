"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { DeepgramSTT, type PronunciationResult, type WordScore } from "@/lib/deepgram-stt";
import { StreamingAudioPlayer } from "@/lib/audio-player";
import { SessionRecorder } from "@/lib/session-recorder";
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
};

interface CefrResult {
  candidate: string;
  language: string;
  level: string;
  score_percent: number;
  confidence: "high" | "medium" | "low";
  dimensions: {
    fluency: number | null;
    vocabulary: number | null;
    grammar: number | null;
    comprehension: number | null;
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

/**
 * Azure free-speech mode clusters scores in the 75-95 range regardless of CEFR level.
 * Linear calibration: displayed = 1.4 × raw − 40
 * Hits the reference table exactly: 95→93, 90→86, 85→79, 80→72, 75→65, 100→100.
 * Applied for display only — raw scores are still passed to Claude as acoustic context.
 */
function deflateAzure(raw: number): number {
  return Math.max(0, Math.round(1.4 * raw - 40));
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

// ─── Azure live panel ─────────────────────────────────────────────────────────

interface AzureAvg {
  pronunciation: number;
  wpm: number;
  score: number;
  count: number;
}

function AzurePanel({ data }: { data: AzureAvg | null }) {
  return (
    <div
      style={{
        padding: 12,
        background: "#0f172a",
        border: "1px solid #1e3a5f",
        borderRadius: 8,
        minHeight: 120,
      }}
    >
      <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, marginBottom: 6, letterSpacing: 1 }}>
        QUALITÉ DE PRONONCIATION
      </div>
      {!data ? (
        <div style={{ color: "#4b5563", fontSize: 12 }}>En attente…</div>
      ) : (
        <>
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1, color: "#f1f5f9" }}>
            {deflateAzure(data.score)}<span style={{ fontSize: 16, color: "#4b5563" }}>/100</span>
          </div>
          <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 8 }}>
            Score acoustique · {data.count} tour{data.count > 1 ? "s" : ""}
          </div>
          <Bar label="Confiance" value={deflateAzure(data.pronunciation)} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 3 }}>
            <span style={{ width: 80, color: "#9ca3af", flexShrink: 0 }}>Débit</span>
            <span style={{ fontWeight: 700, color: "#e5e7eb" }}>{Math.round(data.wpm)}</span>
            <span style={{ color: "#4b5563", fontSize: 10 }}>mots/min</span>
          </div>
          <div style={{ fontSize: 9, color: "#374151", marginTop: 4 }}>
            Mesure acoustique calibrée — pas de niveau CEFR
          </div>
        </>
      )}
    </div>
  );
}

// ─── Claude CEFR panel ────────────────────────────────────────────────────────

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "#4ade80",
  medium: "#facc15",
  low: "#fb923c",
};

function CefrPanel({ result }: { result: CefrResult }) {
  const dims = Object.entries(result.dimensions) as [string, number | null][];

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
          <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1.1 }}>{result.level}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
            Score {result.score_percent}/100
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

      {/* Dimension bars (0-10) */}
      <div style={{ marginBottom: 8 }}>
        {dims.map(([key, val]) =>
          val !== null ? (
            <Bar key={key} label={key} value={val} max={10} />
          ) : (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 3 }}>
              <span style={{ width: 80, color: "#9ca3af", flexShrink: 0 }}>{key}</span>
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
        return (
          <span
            key={i}
            title={`${w.word}: ${pct}% confidence`}
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

  const sttRef = useRef<DeepgramSTT | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const liveAvatarRef = useRef<LiveAvatarHandle | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const sessionSavedRef = useRef(false);
  const historyRef = useRef<Msg[]>([]);
  historyRef.current = history;

  // Derived: average Azure pronunciation scores across all scored user turns
  const azureAvg = useMemo<AzureAvg | null>(() => {
    const scored = history.filter((m) => m.role === "user" && m.pronunciation);
    if (!scored.length) return null;
    const avg = (key: keyof PronunciationResult) => {
      const vals = scored.map((m) => m.pronunciation![key] as number);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const pronunciation = avg("pronunciationScore");
    const wpm = avg("wpm");
    const score = Math.round(pronunciation);
    return {
      pronunciation,
      wpm,
      score,
      count: scored.length,
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

  // Auto-evaluate and close conversation at 4 min
  useEffect(() => {
    if (elapsed === 240 && !cefrResult && !evaluating) {
      runEvaluation();
      handleUserTurn("__END__");
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

  // ── session ──
  const startSession = async () => {
    setSessionStarted(true);
    sessionSavedRef.current = false;
    startedAtRef.current = Date.now();
    recorderRef.current = new SessionRecorder();
    recorderRef.current.start();
    if (!USE_HEYGEN) {
      playerRef.current = new StreamingAudioPlayer((amp) => {
        isSpeakingRef.current = amp > 0;
        setAmplitude(amp);
      });
    }

    sttRef.current = new DeepgramSTT(language, {
      onPartial: (text) => {
        if (isSpeakingRef.current) return;
        setPartialUser(text);
        if (USE_HEYGEN) liveAvatarRef.current?.startListening();
      },
      onFinal: async (text, pronunciation) => {
        if (!text.trim() || isProcessingRef.current || isSpeakingRef.current) return;
        setPartialUser("");
        if (USE_HEYGEN) liveAvatarRef.current?.stopListening();
        await handleUserTurn(text, pronunciation);
      },
      onError: (e) => console.error("STT error:", e),
    });

    // Start STT — but don't let a Deepgram connection failure block the avatar
    // from speaking. Azure TTS is independent and must always start.
    try {
      await sttRef.current.start();
    } catch (e) {
      console.error("Deepgram STT failed to connect:", e);
      // STT is down but TTS still works — avatar will speak, mic input is disabled
    }

    // Kick off the conversation regardless of STT status
    await handleUserTurn("__START__");
  };

  const handleUserTurn = async (userText: string, pronunciation?: PronunciationResult) => {
    isProcessingRef.current = true;
    const isStart = userText === "__START__";
    const isEnd   = userText === "__END__";

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
    // After the closing message, keep isProcessingRef true so STT
    // no longer submits new user turns.
    if (!isEnd) isProcessingRef.current = false;
  };

  const runEvaluation = async () => {
    setEvaluating(true);
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
    sttRef.current?.stop();
    if (!USE_HEYGEN) playerRef.current?.stop();
    const audioBlob = await recorderRef.current?.stop() ?? null;
    await saveSession(audioBlob, cefrResult ?? undefined);
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
            <span style={{ fontFamily: "monospace", fontSize: 13, color: elapsed >= 300 ? "#4ade80" : "#94a3b8" }}>
              {mm}:{ss} {elapsed >= 300 ? "✓" : ""}
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

      {/* ── body ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 520px", flex: 1, overflow: "hidden" }}>
        {/* Avatar */}
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

        {/* Right panel */}
        <aside
          style={{
            borderLeft: "1px solid #1e293b",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Score panels */}
          <div style={{ padding: 12, borderBottom: "1px solid #1e293b", flexShrink: 0 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: cefrResult ? "1fr 1fr" : "1fr",
                gap: 8,
              }}
            >
              <AzurePanel data={azureAvg} />
              {cefrResult && <CefrPanel result={cefrResult} />}
            </div>
          </div>

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
                  {m.role === "user" && m.pronunciation?.words?.length ? (
                    <UserWords words={m.pronunciation.words} />
                  ) : (
                    m.content
                  )}
                </div>
                {m.role === "user" && m.pronunciation && (
                  <UtteranceBadges p={m.pronunciation} />
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
