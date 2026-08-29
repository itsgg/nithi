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
export function parseRun(raw: string): { content: string; sessionId?: string } {
  let completed = "";
  let deltas = "";
  let sessionId: string | undefined;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      if (typeof j.session_id === "string") sessionId = j.session_id;
      if (j.event === "RunCompleted" && typeof j.content === "string") completed = j.content;
      else if (j.event === "RunContent" && typeof j.content === "string") deltas += j.content;
    } catch {
      // ignore unparseable lines
    }
  }
  return { content: (completed || deltas || raw).trim(), sessionId };
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
