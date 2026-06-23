import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt, type ConvLang } from "@/lib/conversation-prompts";

export const runtime = "nodejs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ChatRequest {
  language: ConvLang;
  history: { role: "user" | "assistant"; content: string }[];
  userMessage: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Per-language voice profile.
 *   voice — a natural multilingual / regional neural voice (English was
 *           previously voiced by the FRENCH Vivienne voice — fixed).
 *   style — Azure mstts:express-as conversational style for warmth and
 *           expressiveness; empty when the voice doesn't support styles
 *           (multilingual voices ignore unsupported styles, but we only set
 *           one where it genuinely lands).
 */
const VOICE_PROFILE: Record<ConvLang, { lang: string; voice: string; style: string }> = {
  // en-US-AvaNeural: very natural AND documented to support express-as styles
  // (the Multilingual variant is natural but has no styles — an unsupported
  // style would fail the request and silence the avatar).
  en: { lang: "en-US", voice: "en-US-AvaNeural", style: "chat" },
  fr: { lang: "fr-FR", voice: "fr-FR-VivienneMultilingualNeural", style: "" },
  // nl-BE-DenaNeural has no documented express-as styles — leave style empty so
  // the SSML can't be rejected; it still gets the livelier prosody below.
  "nl-BE": { lang: "nl-BE", voice: "nl-BE-DenaNeural", style: "" },
};

// Speaking-rate presets. The conversation opens slow so low-level listeners
// can follow; it switches to the natural rate once the avatar judges the
// speaker is B1+ (signalled per-reply via a leading level tag — see below).
const SLOW_RATE = "-16%";
const NORMAL_RATE = "-3%";

/**
 * Build expressive SSML.
 * - mstts:express-as style="chat" + styledegree gives a warm, conversational
 *   register instead of the flat reading voice.
 * - prosody rate is caller-supplied (slow for A1/A2 listeners, natural for B1+)
 *   with a slight pitch lift for gentle intonation movement.
 */
function buildSSML(text: string, p: { lang: string; voice: string; style: string }, rate: string): string {
  const inner = `<prosody rate="${rate}" pitch="+3%">${escapeXml(text)}</prosody>`;
  const styled = p.style
    ? `<mstts:express-as style="${p.style}" styledegree="1.3">${inner}</mstts:express-as>`
    : inner;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${p.lang}">` +
    `<voice name="${p.voice}">${styled}</voice></speak>`
  );
}

/**
 * Starts an Azure TTS request immediately and returns a reader for the PCM stream.
 * Calling this function (without await) fires the HTTP request right away so it
 * runs in parallel with Claude generation.
 */
async function startTTS(
  text: string,
  language: ConvLang,
  rate: string
): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
  const key = process.env.AZURE_SPEECH_KEY;
  if (!key || !text.trim()) return null;

  const region = process.env.AZURE_SPEECH_REGION ?? "westeurope";
  const profile = VOICE_PROFILE[language] ?? VOICE_PROFILE.en;

  const res = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
      },
      body: buildSSML(text, profile, rate),
    }
  );

  if (!res.ok || !res.body) {
    console.error("Azure TTS error:", res.status, await res.text().catch(() => ""));
    return null;
  }

  return res.body.getReader();
}

/**
 * POST /api/chat
 * SSE stream:  event: text  → token delta (real-time, unblocked)
 *              event: audio → base64 PCM chunk (streamed per sentence)
 *              event: done  → { fullText }
 *              event: error → { stage, message }
 *
 * Latency strategy:
 *  1. TTS is fired immediately on each sentence boundary — NO await inside Claude loop.
 *  2. All TTS requests run in parallel with Claude generation.
 *  3. Azure TTS response is streamed (chunks forwarded as they arrive).
 *  4. By the time Claude finishes, sentence-1 TTS is already done or nearly done.
 */
export async function POST(req: Request) {
  const { language, history, userMessage } = (await req.json()) as ChatRequest;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));

      let fullText = "";
      let pending = "";

      // Speaking rate for this reply. The avatar prefixes each reply with a
      // level tag ⟦A1⟧…⟦C1⟧ (its presumed level for the speaker); we strip it
      // and pick the rate from it. Default slow until proven B1+.
      let rate = SLOW_RATE;
      // Head-buffer: hold the very start of the reply until the leading level
      // tag is parsed and removed, so it never reaches the caption or TTS.
      let headResolved = false;
      let head = "";

      // Each entry is a Promise that resolves to a streaming reader (or null).
      // Promises are pushed immediately when a sentence boundary is hit — no await.
      const ttsQueue: Promise<ReadableStreamDefaultReader<Uint8Array> | null>[] = [];

      // Emit cleaned (tag-free) text: forward to the caption, accumulate into
      // fullText, and fire TTS on each complete sentence.
      const emit = (chunk: string) => {
        if (!chunk) return;
        fullText += chunk;
        pending += chunk;
        send("text", JSON.stringify({ delta: chunk }));
        let m;
        while ((m = pending.match(/^([\s\S]*?[.!?…])\s/))) {
          ttsQueue.push(startTTS(m[1], language, rate));
          pending = pending.slice(m[0].length);
        }
      };

      try {
        const claudeStream = await anthropic.messages.stream({
          model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
          max_tokens: 300,
          system: getSystemPrompt(language),
          messages: [
            ...history.map(({ role, content }) => ({ role, content })),
            { role: "user", content: userMessage },
          ],
        });

        for await (const event of claudeStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            const piece = event.delta.text;

            if (headResolved) {
              emit(piece);
              continue;
            }

            // Still resolving the leading level tag. Accept the intended ⟦XX⟧
            // glyphs and a [XX] fallback in case the model normalises them.
            head += piece;
            const trimmed = head.replace(/^\s+/, "");
            if (trimmed === "") continue; // only whitespace so far

            if (trimmed[0] !== "⟦" && trimmed[0] !== "[") {
              // No tag present — flush what we have as normal text.
              headResolved = true;
              emit(head);
              head = "";
              continue;
            }

            const tag = head.match(/^\s*[⟦[]\s*(A1|A2|B1|B2|C1)\s*[⟧\]]\s*/i);
            if (tag) {
              const level = tag[1].toUpperCase();
              rate = level === "A1" || level === "A2" ? SLOW_RATE : NORMAL_RATE;
              headResolved = true;
              emit(head.slice(tag[0].length));
              head = "";
            } else if (head.length > 14) {
              // An opening ⟦ that never closed sensibly — give up, treat as text.
              headResolved = true;
              emit(head);
              head = "";
            }
            // else: partial tag, wait for more deltas.
          }
        }

        // Flush any unresolved head (e.g. a lone partial tag at end of stream).
        if (!headResolved && head) emit(head);
        if (pending.trim()) {
          ttsQueue.push(startTTS(pending, language, rate));
        }
      } catch (e) {
        send("error", JSON.stringify({ stage: "llm", message: String(e) }));
      }

      // Drain TTS readers in order. Buffer the entire PCM response for each
      // sentence and send it as ONE audio event. Sending many small events
      // (one per Azure read() chunk) creates arbitrary waveform boundaries
      // mid-sentence which cause audible clicks and static at the player.
      // Since TTS runs in parallel with Claude, the full sentence audio is
      // typically already available by the time we reach this drain phase —
      // buffering adds no meaningful latency.
      for (const readerPromise of ttsQueue) {
        const reader = await readerPromise;
        if (!reader) continue;
        try {
          const chunks: Buffer[] = [];
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value?.length) chunks.push(Buffer.from(value));
          }
          if (chunks.length) {
            send("audio", Buffer.concat(chunks).toString("base64"));
          }
        } finally {
          reader.releaseLock();
        }
      }

      send("done", JSON.stringify({ fullText }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
