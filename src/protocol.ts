import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// A single attachment is truncated at MAX_FILE_CHARS; the attachments together
// are capped at MAX_TOTAL_CHARS so `-f *.log` cannot build a 50 MB prompt that
// the upstream API will only reject after a long upload.
export const MAX_FILE_CHARS = 100_000;
export const MAX_TOTAL_CHARS = 400_000;

/**
 * The /runs body is an Agno SSE stream of `data: {json}` lines. Text arrives as
 * `RunContent` deltas; `RunCompleted` repeats the full answer and carries the
 * session_id needed to continue the conversation.
 */
/**
 * Collapse untrusted text to a single bounded line.
 *
 * Whatever the service puts in an error field is going to be printed in the
 * user's terminal, so it arrives with its control characters removed, its
 * newlines flattened and its length capped: an error is a line, not a payload.
 */
function oneLine(s: string, max = 200): string {
  const flat = s
    // C0 and C1 controls, then the invisible characters that reorder or hide
    // what follows them: a right-to-left override in an error message can make
    // the rest of the line read backwards in the terminal.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(flat, max);
}

/**
 * Cut to `max` user-perceived characters.
 *
 * Segmented by grapheme, not by code unit or code point, so the cut can fall
 * neither between the halves of a surrogate pair nor between a letter and the
 * accent that belongs to it.
 */
function truncate(s: string, max: number): string {
  let units: string[];
  try {
    units = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(
      (g) => g.segment,
    );
  } catch {
    units = [...s]; // no Segmenter: code points still never split a pair
  }
  return units.length > max ? units.slice(0, max - 1).join("") + "…" : s;
}

/** The stream was well formed but carried no answer. */
export class NoAnswerError extends Error {}

export function parseRun(raw: string): { content: string; sessionId?: string } {
  let completed = "";
  let deltas = "";
  let sessionId: string | undefined;
  let failure = "";
  let parsed = 0;
  const events: string[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      parsed++;
      if (typeof j.session_id === "string") sessionId = j.session_id;
      const event = typeof j.event === "string" ? j.event : "";
      if (event && !events.includes(event)) events.push(event);
      if (event === "RunCompleted" && typeof j.content === "string") completed = j.content;
      else if (event === "RunContent" && typeof j.content === "string") deltas += j.content;
      else if (!failure) {
        // Only fields the service labels as errors. Not `content`, which on an
        // unknown event could be anything at all.
        const reported = typeof j.error === "string" ? j.error : typeof j.detail === "string" ? j.detail : "";
        if (reported) failure = oneLine(reported);
        else if (/error|fail|cancel/i.test(event)) failure = oneLine(`the service reported ${event}`);
      }
    } catch {
      // ignore unparseable lines
    }
  }

  // Trim before choosing, not after. A whitespace-only RunCompleted is truthy,
  // and used to mask perfectly good deltas that the user had already watched
  // arrive, turning a delivered answer into an error.
  const content = completed.trim() || deltas.trim();
  if (content) return { content, sessionId };

  // The stream parsed but carried no answer: lifecycle events only, or an error
  // the service reported inside the stream. Returning the raw body here used to
  // print the whole SSE transcript, hundreds of lines of JSON including the
  // session id, as if it were the reply. The test is whether anything parsed at
  // all, not whether an event carried a name: the name can live on the SSE
  // `event:` line, which is not JSON and never reaches this parser.
  if (parsed > 0) {
    const seen = events
      .slice(0, 6)
      .map((e) => oneLine(e, 40))
      .join(", ");
    throw new NoAnswerError(
      oneLine(failure || `the service sent no answer${seen ? ` (events: ${seen})` : ""}`),
    );
  }

  // Not an event stream at all: whatever the body is, it is all we have.
  return { content: raw.trim(), sessionId };
}

/**
 * Build the outgoing message: an optional system preamble, any attached files
 * as fenced blocks, then the question.
 */
export function buildMessage(question: string, files: string[], system?: string): string {
  let prefix = "";
  if (system && system.trim()) prefix += system.trim() + "\n\n";
  let budget = MAX_TOTAL_CHARS;
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      throw new Error(`cannot read file: ${f}`);
    }
    const room = Math.min(MAX_FILE_CHARS, budget);
    if (room <= 0) {
      prefix += `File: ${basename(f)}\n(omitted: attachment budget exhausted)\n\n`;
      continue;
    }
    if (content.length > room) content = content.slice(0, room) + "\n...(truncated)";
    budget -= content.length;
    prefix += `File: ${basename(f)}\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  return prefix + question;
}

/** Pull @path tokens out of a REPL line and treat existing ones as attachments. */
export function extractAtFiles(line: string): { text: string; files: string[] } {
  const files: string[] = [];
  const text = line
    .replace(/(^|\s)@(\S+)/g, (m, pre, path) => {
      const p = path.replace(/^~(?=\/|$)/, homedir());
      if (existsSync(p)) {
        files.push(p);
        return pre;
      }
      return m;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, files };
}
