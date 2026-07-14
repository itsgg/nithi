#!/usr/bin/env node
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import net from "node:net";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// nithi - ask Nithyananda (ask.nithyananda.ai) from your terminal.
// Modes: one-shot, piped stdin, and an interactive REPL. Supports named
// sessions with real conversation memory and file attachments.
// ---------------------------------------------------------------------------

const BASE = "https://ask.nithyananda.ai/";
const ORIGIN = "https://ask.nithyananda.ai";
const API = "https://ask.nithyananda.ai/v1/agents/ngpt-v4/runs";
const UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";

const CACHE = join(homedir(), ".cache", "nithi");
const STATE_FILE = join(CACHE, "state.json"); // cookies + Cloudflare clearance
const SESS_DIR = join(CACHE, "sessions");
const SOCK = join(CACHE, "daemon.sock");
const DPID = join(CACHE, "daemon.pid");
const DLOG = join(CACHE, "daemon.log");
const IDLE_MS = (Number(process.env.NITHI_IDLE_MIN) || 15) * 60000;

const HEADLESS = !process.env.HEADFUL;

// --- CLI args --------------------------------------------------------------

interface Opts {
  question: string;
  files: string[];
  session?: string;
  system?: string;
  cont: boolean;
  fresh: boolean;
  interactive: boolean;
  list: boolean;
  raw: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    question: "",
    files: [],
    cont: false,
    fresh: false,
    interactive: false,
    list: false,
    raw: false,
    help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-s":
      case "--session":
        o.session = argv[++i];
        break;
      case "-f":
      case "--file":
        o.files.push(argv[++i]);
        break;
      case "-y":
      case "--system":
        o.system = argv[++i];
        break;
      case "-c":
      case "--continue":
        o.cont = true;
        break;
      case "--new":
        o.fresh = true;
        break;
      case "-i":
      case "--interactive":
        o.interactive = true;
        break;
      case "--list":
        o.list = true;
        break;
      case "--raw":
        o.raw = true;
        break;
      case "-h":
      case "--help":
        o.help = true;
        break;
      default:
        rest.push(a);
    }
  }
  o.question = rest.join(" ").trim();
  return o;
}

const OPTS = parseArgs(process.argv.slice(2));

// --- terminal theme --------------------------------------------------------

const ESC = "\x1b[";
const COLS = process.stdout.columns || 80;
const USE_COLOR =
  !OPTS.raw && !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
const TRUECOLOR =
  process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";
const HYPERLINKS =
  USE_COLOR && !process.env.NO_HYPERLINKS && process.env.TERM !== "dumb";

const attr = (open: string, close: string) => (s: string) =>
  USE_COLOR ? `${ESC}${open}m${s}${ESC}${close}m` : s;
const bold = attr("1", "22");
const italic = attr("3", "23");
const dim = attr("2", "22");
const underline = attr("4", "24");

function to256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const colorFn = (layer: 38 | 48, reset: 39 | 49) => (rgb: number[]) => {
  if (!USE_COLOR) return (s: string) => s;
  const [r, g, b] = rgb;
  const code = TRUECOLOR ? `${layer};2;${r};${g};${b}` : `${layer};5;${to256(r, g, b)}`;
  return (s: string) => `${ESC}${code}m${s}${ESC}${reset}m`;
};
const fg = colorFn(38, 39);
const bg = colorFn(48, 49);

const T = {
  h1: fg([245, 158, 66]),
  h2: fg([234, 179, 8]),
  accent: fg([245, 158, 66]),
  tag: fg([250, 204, 21]),
  muted: fg([130, 130, 145]),
  link: fg([96, 165, 250]),
  code: fg([236, 186, 120]),
  codeBg: bg([38, 38, 48]),
};

const stripAnsi = (s: string) =>
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const vlen = (s: string) => [...stripAnsi(s)].length;

function osc8(url: string, text: string): string {
  if (!HYPERLINKS) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
function renderLink(url: string, text: string): string {
  if (HYPERLINKS) return T.link(underline(osc8(url, text)));
  if (text === url) return T.link(underline(url));
  return T.link(underline(text)) + T.muted(" (" + url + ")");
}

function inline(s: string): string {
  const spans: string[] = [];
  const stash = (v: string) => `\x00${spans.push(v) - 1}\x00`;
  s = s.replace(/`([^`]+)`/g, (_, c) => stash(T.codeBg(T.code(" " + c + " "))));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => stash(renderLink(u, t)));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)\]]+)/g, (_, pre, u) => pre + stash(renderLink(u, u)));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t));
  s = s.replace(/__([^_]+)__/g, (_, t) => bold(t));
  s = s.replace(/\*([^*\n]+)\*/g, (_, t) => italic(t));
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, (_, pre, t) => pre + italic(t));
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => spans[+i]);
  return s;
}

function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let cur = "";
    for (let w of words) {
      while (w.length > width) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (cur && cur.length + 1 + w.length > width) {
        out.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + " " + w : w;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

// --- tables ----------------------------------------------------------------

type Align = "left" | "right" | "center";

function padCell(styled: string, width: number, align: Align): string {
  const gap = Math.max(0, width - vlen(styled));
  if (align === "right") return " ".repeat(gap) + styled;
  if (align === "center") {
    const l = gap >> 1;
    return " ".repeat(l) + styled + " ".repeat(gap - l);
  }
  return styled + " ".repeat(gap);
}

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function renderTable(rows: string[][], aligns: Align[]): string {
  const ncol = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => {
    const c = r.slice();
    while (c.length < ncol) c.push("");
    return c;
  });
  const align = (i: number): Align => aligns[i] ?? "left";

  const widths = Array.from({ length: ncol }, (_, i) =>
    Math.max(3, ...rows.map((r) => vlen(r[i]))),
  );
  const budget = Math.min(COLS, 118) - (ncol * 3 + 1);
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 6) break;
    widths[i]--;
    total--;
  }

  const seg = (w: number) => "─".repeat(w + 2);
  const top = T.muted("╭" + widths.map(seg).join("┬") + "╮");
  const mid = T.muted("├" + widths.map(seg).join("┼") + "┤");
  const bot = T.muted("╰" + widths.map(seg).join("┴") + "╯");
  const bar = T.muted("│");

  // Cells are styled by the table (header bold); strip emphasis markers so a
  // *span* that wraps across cell lines doesn't leave literal * or ** behind.
  const stripBold = (s: string) => s.replace(/\*+/g, "").replace(/__/g, "");
  const drawRow = (cells: string[], header: boolean) => {
    const wrapped = cells.map((c, i) => wrapPlain(stripBold(c), widths[i]));
    const height = Math.max(...wrapped.map((w) => w.length));
    const lines: string[] = [];
    for (let li = 0; li < height; li++) {
      const parts = wrapped.map((w, i) => {
        const raw = w[li] ?? "";
        const styled = header ? bold(T.h2(inline(raw))) : inline(raw);
        return " " + padCell(styled, widths[i], align(i)) + " ";
      });
      lines.push(bar + parts.join(bar) + bar);
    }
    return lines.join("\n");
  };

  const out = [top, drawRow(rows[0], true), mid];
  for (const r of rows.slice(1)) out.push(drawRow(r, false));
  out.push(bot);
  return out.join("\n");
}

function renderTableFromMd(tbl: string[]): string {
  const header = splitRow(tbl[0]);
  const aligns: Align[] = splitRow(tbl[1]).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
  const body = tbl.slice(2).map(splitRow);
  return renderTable([header, ...body], aligns);
}

// --- code blocks -----------------------------------------------------------

function renderCodeBlock(code: string[], lang: string): string {
  const width = Math.min(
    Math.max(0, ...code.map((l) => l.length)),
    Math.max(20, Math.min(COLS - 6, 100)),
  );
  const out: string[] = [];
  if (lang) out.push("  " + T.muted(lang));
  const barCh = T.muted("▕");
  for (const l of code) {
    const padded = (l + " ".repeat(Math.max(0, width - l.length))).slice(0, width);
    out.push("  " + barCh + T.codeBg(T.code(" " + padded + " ")));
  }
  return out.join("\n");
}

// --- markdown --------------------------------------------------------------

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(renderCodeBlock(code, fence[1]));
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("|") &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])
    ) {
      const tbl: string[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "")
        tbl.push(lines[i++]);
      out.push(renderTableFromMd(tbl));
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(T.muted("─".repeat(Math.min(COLS, 60))));
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const txt = inline(h[2]);
      if (h[1].length === 1) {
        out.push("", T.h1(bold(txt)), T.muted("─".repeat(Math.min(COLS, vlen(txt) + 4))));
      } else if (h[1].length === 2) {
        out.push("", T.h2(bold(txt)));
      } else {
        out.push(bold(txt));
      }
      i++;
      continue;
    }

    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) {
      out.push(T.accent("▏ ") + T.muted(italic(inline(bq[1]))));
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(bullet[1] + T.accent("•") + " " + inline(bullet[2]));
      i++;
      continue;
    }

    const num = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (num) {
      out.push(num[1] + T.accent(num[2] + ".") + " " + inline(num[3]));
      i++;
      continue;
    }

    out.push(inline(line));
    i++;
  }
  return out.join("\n");
}

// --- openui ----------------------------------------------------------------

const unescapeStr = (s: string) =>
  s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

const extractStrings = (s: string) =>
  [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeStr(m[1]));

function renderCard(args: string[]): string {
  const parts = args.filter((a) => !/^https?:\/\/\S+$/i.test(a.trim()));
  const title = parts[0] ?? "";
  const rest = parts.slice(1);
  const isShort = (x: string) => x.length <= 40 && !x.includes("\n");

  let tag = "";
  if (rest.length >= 2 && isShort(rest[rest.length - 1])) tag = rest.pop()!;
  let subtitle = "";
  if (rest.length >= 2) subtitle = rest.shift()!;
  const body = rest.join("\n\n");

  const bar = T.accent("▌ ");
  const barE = T.accent("▌");
  const lines = [bar + bold(T.h1(title))];
  if (subtitle) lines.push(bar + T.muted(italic(subtitle)));
  if (body.trim()) {
    lines.push(barE);
    for (const l of renderMarkdown(body).split("\n")) lines.push(bar + l);
  }
  if (tag) {
    lines.push(barE);
    lines.push(bar + T.tag("◆ " + tag));
  }
  return lines.join("\n");
}

function renderStats(block: string): string | null {
  const rows = [...block.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => {
      const field = (k: string) =>
        unescapeStr(m[1].match(new RegExp(k + '\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'))?.[1] ?? "");
      return { label: field("label"), value: field("value"), unit: field("unit") };
    })
    .filter((r) => r.label || r.value);
  if (!rows.length) return null;
  const w = Math.max(...rows.map((r) => r.label.length));
  return rows
    .map(
      (r) =>
        "  " +
        T.muted(r.label.padEnd(w)) +
        "  " +
        bold(T.accent(r.value)) +
        (r.unit ? " " + T.muted(r.unit) : ""),
    )
    .join("\n");
}

function renderOpenUI(block: string): string {
  const title = block.match(/title="([^"]*)"/)?.[1];
  const heading = title
    ? T.h1(bold(title)) + "\n" + T.muted("─".repeat(Math.min(COLS, title.length + 4))) + "\n\n"
    : "";

  if (/\bCard\s*\(/.test(block)) {
    const cards: string[] = [];
    const cardRe = /Card\(((?:"(?:[^"\\]|\\.)*"|[^()])*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = cardRe.exec(block))) {
      const args = extractStrings(m[1]);
      if (args.length) cards.push(renderCard(args));
    }
    if (cards.length) return heading + cards.join("\n\n") + "\n";
  }

  if (/\bStatDisplay\s*\(/.test(block)) {
    const s = renderStats(block);
    if (s) return heading + s + "\n";
  }

  const strings = extractStrings(block.replace(/title="[^"]*"/, ""));
  if (strings.length) return heading + strings.map((x) => "  " + inline(x)).join("\n") + "\n";
  return dim(block);
}

function render(text: string): string {
  const re = /<openui\b[^>]*>[\s\S]*?<\/openui>/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += renderMarkdown(text.slice(last, m.index));
    out += renderOpenUI(m[0]);
    last = m.index + m[0].length;
  }
  out += renderMarkdown(text.slice(last));
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// --- response parsing ------------------------------------------------------

// The /runs body is an Agno SSE stream of `data: {json}` lines. Text arrives as
// `RunContent` deltas; `RunCompleted` repeats the full answer and carries the
// session_id needed to continue the conversation.
function parseRun(raw: string): { content: string; sessionId?: string } {
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
      if (j.session_id) sessionId = j.session_id;
      if (j.event === "RunCompleted" && typeof j.content === "string") completed = j.content;
      else if (j.event === "RunContent" && typeof j.content === "string") deltas += j.content;
    } catch {
      // ignore unparseable lines
    }
  }
  return { content: (completed || deltas || raw).trim(), sessionId };
}

// --- sessions --------------------------------------------------------------

interface Session {
  name: string;
  sessionId?: string;
  system?: string; // preamble prepended to each message
  createdAt: number;
  updatedAt: number;
  turns: { q: string; a: string; at: number }[];
}

const sessFile = (name: string) => join(SESS_DIR, name.replace(/[^\w.-]/g, "_") + ".json");
const newSession = (name: string): Session => ({
  name,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: [],
});

function loadSession(name: string): Session | null {
  try {
    return JSON.parse(readFileSync(sessFile(name), "utf8"));
  } catch {
    return null;
  }
}
function saveSession(s: Session) {
  mkdirSync(SESS_DIR, { recursive: true });
  writeFileSync(sessFile(s.name), JSON.stringify(s, null, 2));
}
function latestSession(): Session | null {
  try {
    const files = readdirSync(SESS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: statSync(join(SESS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files[0] ? JSON.parse(readFileSync(join(SESS_DIR, files[0].f), "utf8")) : null;
  } catch {
    return null;
  }
}
function listSessions(): Session[] {
  try {
    return readdirSync(SESS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(SESS_DIR, f), "utf8")) as Session)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

// --- transport -------------------------------------------------------------

class Nithi {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private onDelta?: (chunk: string) => void;
  private sseBuf = "";

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: HEADLESS });
    this.context = await this.browser.newContext({
      userAgent: UA,
      viewport: { width: 390, height: 844 },
      ...(existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}),
    });
    // Pre-set the flags the site checks so the language/app-nag modals never render.
    await this.context.addInitScript(() => {
      try {
        localStorage.setItem("languageSelected", "true");
        localStorage.setItem("appNudgeBannerDismissed_v1", "true");
        localStorage.setItem("explainerMode", "false");
      } catch {}
    });
    this.page = await this.context.newPage();
    // Bridge streamed chunks from the in-page fetch back to Node.
    await this.page.exposeFunction("__nithiDelta", (chunk: string) => this.onDelta?.(chunk));
    await this.page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
    await this.persist();
  }

  // Stream the answer from the agent API via an in-page fetch (same-origin, so
  // it carries the Cloudflare clearance). Calls onContent with each text delta
  // and returns the full answer plus the session_id.
  async askStream(
    message: string,
    sessionId?: string,
    onContent: (piece: string) => void = () => {},
    retried = false,
  ): Promise<{ content: string; sessionId?: string }> {
    this.sseBuf = "";
    this.onDelta = (chunk) => this.feed(chunk, onContent);
    const res = await this.page!.evaluate(
      async ({ url, message, sessionId }) => {
        const fd = new FormData();
        fd.append("message", message);
        fd.append("stream", "true");
        if (sessionId) fd.append("session_id", sessionId);
        let resp: Response;
        try {
          resp = await fetch(url, {
            method: "POST",
            body: fd,
            headers: { Accept: "text/event-stream" },
          });
        } catch (e) {
          return { status: 0, text: String(e) };
        }
        if (!resp.ok || !resp.body)
          return { status: resp.status, text: await resp.text().catch(() => "") };
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let full = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          full += chunk;
          (window as unknown as { __nithiDelta: (c: string) => void }).__nithiDelta(chunk);
        }
        return { status: 200, text: full };
      },
      { url: API, message, sessionId: sessionId ?? "" },
    );
    this.onDelta = undefined;
    if (res.status !== 200) {
      const challenged =
        res.status === 403 ||
        res.status === 0 ||
        /just a moment|cloudflare|cf-mitigated/i.test(res.text);
      // Stale clearance: reload to re-solve the challenge, then retry once.
      if (challenged && !retried) {
        await this.page!.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(
          () => {},
        );
        await this.persist();
        return this.askStream(message, sessionId, onContent, true);
      }
      const hint = challenged
        ? " (Cloudflare challenge - wait a moment, or run once with HEADFUL=1)"
        : "";
      throw new Error(`request failed: HTTP ${res.status}${hint}`);
    }
    return parseRun(res.text);
  }

  // Incrementally parse the SSE buffer, emitting each RunContent text delta.
  private feed(chunk: string, onContent: (piece: string) => void): void {
    this.sseBuf += chunk;
    let i: number;
    while ((i = this.sseBuf.indexOf("\n")) >= 0) {
      const line = this.sseBuf.slice(0, i).trim();
      this.sseBuf = this.sseBuf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.event === "RunContent" && typeof j.content === "string") onContent(j.content);
      } catch {
        // partial or non-JSON line
      }
    }
  }

  ask(message: string, sessionId?: string) {
    return this.askStream(message, sessionId);
  }

  async persist(): Promise<void> {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      await this.context!.storageState({ path: STATE_FILE });
    } catch {
      // non-fatal
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}

// --- helpers ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spinner(label = "thinking") {
  if (!USE_COLOR || !process.stderr.isTTY) return { stop() {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stderr.write("\r" + T.accent(frames[i++ % frames.length]) + T.muted(" " + label + "…"));
  }, 80);
  return {
    stop() {
      clearInterval(id);
      process.stderr.write("\r\x1b[2K");
    },
  };
}

// Largest prefix of buf that ends at a completed top-level block boundary (a
// blank line, a closed code fence, or a closed <openui>), so we never render a
// half-finished block. Blank lines inside fences/openui don't count. Returns 0
// when nothing is safely renderable yet.
function safeCut(buf: string): number {
  const lines = buf.split("\n");
  let inFence = false;
  let inOpenui = false;
  let pos = 0;
  let cut = 0;
  for (let k = 0; k < lines.length - 1; k++) {
    // exclude the last (possibly partial) line
    const line = lines[k];
    pos += line.length + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (!inFence) cut = pos;
      continue;
    }
    if (inFence) continue;
    if (/<openui\b/.test(line)) inOpenui = true;
    if (inOpenui) {
      if (/<\/openui>/.test(line)) {
        inOpenui = false;
        cut = pos;
      }
      continue;
    }
    if (line.trim() === "") cut = pos;
  }
  return cut;
}

// Progressive renderer: prints completed blocks (formatted) as they stream in,
// append-only so nothing on screen is ever rewritten (no flicker), and shows a
// dim single-line ticker of the in-progress block below them.
function streamRender() {
  const tty = USE_COLOR && process.stderr.isTTY;
  let buf = "";
  let printed = 0;
  const clearTicker = () => {
    if (tty) process.stderr.write("\r" + ESC + "2K");
  };
  const showTicker = () => {
    if (!tty) return;
    const tail = buf.replace(/\s+/g, " ").trim();
    const room = Math.max(10, COLS - 4);
    const s = tail.length > room ? "…" + tail.slice(-(room - 1)) : tail || "thinking…";
    process.stderr.write("\r" + ESC + "2K" + T.accent("◍ ") + T.muted(s));
  };
  const flush = (final: boolean) => {
    for (;;) {
      const cut = final ? buf.length : safeCut(buf);
      if (cut <= 0) break;
      const out = render(buf.slice(0, cut));
      buf = buf.slice(cut);
      if (out) {
        clearTicker();
        process.stdout.write("\n" + out + "\n");
        printed++;
      }
      if (final) break;
    }
  };
  return {
    push(chunk: string) {
      buf += chunk;
      flush(false);
      showTicker();
    },
    finish(content: string) {
      flush(true);
      clearTicker();
      // No deltas streamed (some responses only carry the final): print it once.
      if (printed === 0 && content.trim()) process.stdout.write("\n" + render(content) + "\n");
    },
    stop() {
      clearTicker();
    },
  };
}

// Build the message: an optional system preamble, any attached files as fenced
// blocks, then the question.
function buildMessage(question: string, files: string[], system?: string): string {
  let prefix = "";
  if (system && system.trim()) prefix += system.trim() + "\n\n";
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      throw new Error(`cannot read file: ${f}`);
    }
    if (content.length > 100000) content = content.slice(0, 100000) + "\n...(truncated)";
    prefix += `File: ${basename(f)}\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  return prefix + question;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// Pull @path tokens out of a REPL line and treat existing ones as attachments.
function extractAtFiles(line: string): { text: string; files: string[] } {
  const files: string[] = [];
  const text = line
    .replace(/(^|\s)@(\S+)/g, (m, pre, path) => {
      const p = path.replace(/^~(?=\/)/, homedir());
      if (existsSync(p)) {
        files.push(p);
        return pre;
      }
      return m;
    })
    .trim();
  return { text, files };
}

const printAnswer = (content: string) =>
  process.stdout.write("\n" + render(content) + "\n\n");

// --- daemon ----------------------------------------------------------------
// One warm browser holds a single Cloudflare clearance and serves every query
// over a local Unix socket, so repeat calls don't each launch a browser and
// re-solve a challenge. Auto-started on demand; idles out after inactivity.

interface Reply {
  ok: boolean;
  content?: string;
  sessionId?: string;
  error?: string;
  pong?: boolean;
  pid?: number;
  started?: number;
}

function daemonRequest(payload: unknown, timeoutMs = 130000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    let buf = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
      sock.end();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("daemon timeout"))), timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0)
        finish(() => {
          try {
            resolve(JSON.parse(buf.slice(0, nl)));
          } catch (e) {
            reject(e as Error);
          }
        });
    });
    sock.on("error", (e) => finish(() => reject(e)));
    sock.on("close", () => finish(() => reject(new Error("daemon closed"))));
  });
}

// Streaming ask: forwards each text delta to onDelta, resolves on completion.
function daemonAsk(
  payload: unknown,
  onDelta: (piece: string) => void,
  timeoutMs = 130000,
): Promise<{ content: string; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    let buf = "";
    let done = false;
    const end = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
      sock.end();
    };
    const timer = setTimeout(() => end(() => reject(new Error("daemon timeout"))), timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: { t?: string; d?: string; content?: string; sessionId?: string; error?: string };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.t === "d") onDelta(m.d ?? "");
        else if (m.t === "done") end(() => resolve({ content: m.content ?? "", sessionId: m.sessionId }));
        else if (m.t === "err") end(() => reject(new Error(m.error || "daemon error")));
      }
    });
    sock.on("error", (e) => end(() => reject(e)));
    sock.on("close", () => end(() => reject(new Error("daemon closed"))));
  });
}

async function pingDaemon(): Promise<Reply | null> {
  try {
    const r = await daemonRequest({ op: "ping" }, 2000);
    return r?.pong ? r : null;
  } catch {
    return null;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await pingDaemon()) return;
  mkdirSync(CACHE, { recursive: true });
  const log = openSync(DLOG, "a");
  const child = spawn(process.execPath, [process.argv[1], "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(400);
    if (await pingDaemon()) return;
  }
  throw new Error("daemon did not start (see " + DLOG + ")");
}

async function runDaemon(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  if (await pingDaemon()) {
    process.stderr.write("nithi daemon already running\n");
    return;
  }
  try {
    unlinkSync(SOCK);
  } catch {}

  const nithi = new Nithi();
  await nithi.start();

  const started = Date.now();
  let lastActivity = Date.now();
  let queue: Promise<unknown> = Promise.resolve();

  const send = (sock: net.Socket, reply: Reply) => {
    if (!sock.destroyed) sock.end(JSON.stringify(reply) + "\n");
  };

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req: { op?: string; message?: string; sessionId?: string };
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        return send(sock, { ok: false, error: "bad request" });
      }
      lastActivity = Date.now();
      if (req.op === "ping") return send(sock, { ok: true, pong: true, pid: process.pid, started });
      if (req.op === "stop") {
        send(sock, { ok: true });
        return void shutdown();
      }
      if (req.op === "ask" && req.message) {
        queue = queue.then(async () => {
          try {
            const r = await nithi.askStream(req.message!, req.sessionId, (piece) => {
              if (!sock.destroyed) sock.write(JSON.stringify({ t: "d", d: piece }) + "\n");
            });
            lastActivity = Date.now();
            if (!sock.destroyed)
              sock.end(
                JSON.stringify({ t: "done", content: r.content, sessionId: r.sessionId }) + "\n",
              );
          } catch (e) {
            if (!sock.destroyed)
              sock.end(JSON.stringify({ t: "err", error: (e as Error).message }) + "\n");
          }
        });
        return;
      }
      send(sock, { ok: false, error: "unknown op" });
    });
  });

  await new Promise<void>((res) => server.listen(SOCK, res));
  try {
    writeFileSync(DPID, String(process.pid));
  } catch {}
  process.stderr.write(`nithi daemon listening (pid ${process.pid})\n`);

  const idle = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) shutdown();
  }, 30000);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(idle);
    try {
      server.close();
    } catch {}
    for (const f of [SOCK, DPID]) {
      try {
        unlinkSync(f);
      } catch {}
    }
    await nithi.close().catch(() => {});
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function stopDaemon(): Promise<void> {
  try {
    await daemonRequest({ op: "stop" }, 3000);
    process.stdout.write(T.muted("daemon stopped\n"));
  } catch {
    process.stdout.write(T.muted("no daemon running\n"));
  }
}

async function daemonStatus(): Promise<void> {
  const r = await pingDaemon();
  if (r) {
    const up = r.started ? Math.round((Date.now() - r.started) / 1000) : 0;
    process.stdout.write(T.accent("● ") + "daemon running " + T.muted(`(pid ${r.pid}, up ${up}s)`) + "\n");
  } else {
    process.stdout.write(T.muted("○ daemon not running\n"));
  }
}

// --- transport (daemon, with direct fallback) ------------------------------

interface Transport {
  ask(
    message: string,
    sessionId?: string,
    onContent?: (piece: string) => void,
  ): Promise<{ content: string; sessionId?: string }>;
  close(): Promise<void>;
}

class DaemonTransport implements Transport {
  ask(message: string, sessionId?: string, onContent?: (piece: string) => void) {
    return daemonAsk({ op: "ask", message, sessionId }, onContent ?? (() => {}));
  }
  async close() {} // leave the daemon warm
}

class DirectTransport implements Transport {
  private nithi = new Nithi();
  start() {
    return this.nithi.start();
  }
  ask(message: string, sessionId?: string, onContent?: (piece: string) => void) {
    return this.nithi.askStream(message, sessionId, onContent);
  }
  close() {
    return this.nithi.close();
  }
}

async function makeTransport(): Promise<Transport> {
  if (!process.env.NITHI_NO_DAEMON) {
    const spin = spinner("connecting");
    try {
      await ensureDaemon();
      spin.stop();
      return new DaemonTransport();
    } catch {
      spin.stop();
    }
  }
  const spin = spinner("starting");
  const direct = new DirectTransport();
  try {
    await direct.start();
  } finally {
    spin.stop();
  }
  return direct;
}

// --- flows -----------------------------------------------------------------

function resolveSession(): Session | null {
  if (OPTS.session) return loadSession(OPTS.session) || newSession(OPTS.session);
  if (OPTS.cont) return latestSession();
  return null;
}

async function askAndRecord(
  tx: Transport,
  session: Session | null,
  question: string,
  files: string[],
): Promise<void> {
  const sr = streamRender();
  try {
    const useSession = session && !OPTS.fresh ? session.sessionId : undefined;
    const system = OPTS.system ?? session?.system;
    const { content, sessionId } = await tx.ask(
      buildMessage(question, files, system),
      useSession,
      (piece) => sr.push(piece),
    );
    sr.finish(content);
    if (session) {
      if (sessionId) session.sessionId = sessionId;
      if (OPTS.system) session.system = OPTS.system;
      session.turns.push({ q: question, a: content, at: Date.now() });
      session.updatedAt = Date.now();
      saveSession(session);
    }
  } finally {
    sr.stop();
  }
}

async function runOnce(): Promise<void> {
  const question = OPTS.question || (await readStdin());
  if (!question) {
    printHelp();
    process.exit(2);
  }
  const session = resolveSession();
  const tx = await makeTransport();
  try {
    await askAndRecord(tx, session, question, OPTS.files);
  } finally {
    await tx.close();
  }
}

async function runInteractive(): Promise<void> {
  let session =
    resolveSession() ||
    newSession("chat-" + new Date().toISOString().slice(0, 16).replace(/[:T-]/g, ""));

  const tx = await makeTransport();

  process.stdout.write(
    T.h1(bold("Ask Nithyananda")) +
      T.muted("  session: " + session.name) +
      (session.turns.length ? T.muted(`  (${session.turns.length} prior turns)`) : "") +
      "\n" +
      T.muted("Type a question. /help for commands, /exit to quit.") +
      "\n",
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => T.accent("nithi ▸ ");

  if (OPTS.question) {
    process.stdout.write(prompt() + OPTS.question + "\n");
    await askAndRecord(tx, session, OPTS.question, OPTS.files);
  }

  let running = true;
  while (running) {
    let line: string;
    try {
      line = (await rl.question(prompt())).trim();
    } catch {
      break;
    }
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      switch (cmd) {
        case "exit":
        case "quit":
        case "q":
          running = false;
          break;
        case "new":
          session = newSession("chat-" + new Date().toISOString().slice(0, 19).replace(/[:T-]/g, ""));
          process.stdout.write(T.muted("Started new session: " + session.name + "\n"));
          break;
        case "session":
          if (!args[0]) {
            process.stdout.write(T.muted("Current session: " + session.name + "\n"));
          } else {
            session = loadSession(args[0]) || newSession(args[0]);
            process.stdout.write(T.muted(`Switched to "${session.name}" (${session.turns.length} turns)\n`));
          }
          break;
        case "system":
          if (!args.length)
            process.stdout.write(T.muted("System: " + (session.system || "(none)") + "\n"));
          else if (args[0] === "clear") {
            session.system = undefined;
            saveSession(session);
            process.stdout.write(T.muted("System note cleared.\n"));
          } else {
            session.system = args.join(" ");
            saveSession(session);
            process.stdout.write(T.muted("System note set.\n"));
          }
          break;
        case "history":
          if (!session.turns.length) process.stdout.write(T.muted("No turns yet.\n"));
          for (const t of session.turns)
            process.stdout.write(T.accent("▸ ") + t.q + "\n" + dim(render(t.a)) + "\n\n");
          break;
        case "clear":
          process.stdout.write("\x1b[2J\x1b[H");
          break;
        case "help":
          printReplHelp();
          break;
        default:
          process.stdout.write(T.muted("Unknown command. /help for the list.\n"));
      }
      continue;
    }

    const { text, files } = extractAtFiles(line);
    try {
      await askAndRecord(tx, session, text || line, files);
    } catch (e) {
      process.stdout.write(T.tag("! ") + (e as Error).message + "\n");
    }
  }

  rl.close();
  await tx.close();
  process.stdout.write(T.muted("\nNithyanandam. Session saved as " + session.name + ".\n"));
}

// --- help / list -----------------------------------------------------------

function printHelp(): void {
  const b = (s: string) => bold(s);
  process.stdout.write(
    `${T.h1(bold("nithi"))} ${T.muted("- ask Nithyananda from your terminal")}

${b("Usage")}
  nithi [options] [question]

${b("Modes")}
  nithi "question"        one-shot answer
  nithi                   interactive chat (REPL)
  echo "q" | nithi        read the question from stdin

${b("Options")}
  -s, --session NAME      use or resume a named session (remembers context)
  -c, --continue          resume the most recent session
      --new               start fresh, ignoring the saved session_id
  -f, --file PATH         attach a file's contents (repeatable)
  -y, --system TEXT       prepend a steering instruction (a soft system prompt)
  -i, --interactive       open the REPL (asks the given question first)
      --list              list saved sessions
      --raw               plain text, no color or markdown styling
  -h, --help              show this help

${b("Sessions")}
  nithi --list            list saved sessions
  nithi forget NAME       delete a session
  nithi forget --all      delete all sessions

${b("Daemon")} ${T.muted("(a warm browser reused across calls; auto-started)")}
  nithi status            is the daemon running?
  nithi stop              stop the daemon
  nithi serve             run the daemon in the foreground

${b("In the REPL")}
  @path in a message      attach a file
  /session [NAME]         show or switch/resume a session
  /system [TEXT|clear]    show/set/clear a steering instruction
  /new                    start a new session
  /history                replay this session's turns
  /clear                  clear the screen
  /exit                   quit

${b("Env")}
  HEADFUL=1  NO_COLOR=1  FORCE_COLOR=1  NO_HYPERLINKS=1
  NITHI_NO_DAEMON=1  NITHI_IDLE_MIN=15
`,
  );
}

function printReplHelp(): void {
  process.stdout.write(
    T.muted(
      [
        "  @path                 attach a file to the message",
        "  /session [NAME]        show or switch/resume a session",
        "  /system [TEXT|clear]   show/set/clear a steering instruction",
        "  /new                   start a new session",
        "  /history               replay this session's turns",
        "  /clear                 clear the screen",
        "  /exit                  quit",
      ].join("\n") + "\n",
    ),
  );
}

function printSessions(): void {
  const sessions = listSessions();
  if (!sessions.length) {
    process.stdout.write(T.muted("No saved sessions.\n"));
    return;
  }
  for (const s of sessions) {
    const when = new Date(s.updatedAt).toLocaleString();
    process.stdout.write(T.accent("• ") + bold(s.name) + T.muted(`  ${s.turns.length} turns  ${when}`) + "\n");
    const last = s.turns[s.turns.length - 1];
    if (last) process.stdout.write(T.muted("    last: " + last.q.slice(0, 70)) + "\n");
  }
}

function forgetSessions(args: string[]): void {
  if (args[0] === "--all") {
    let n = 0;
    try {
      for (const f of readdirSync(SESS_DIR))
        if (f.endsWith(".json")) {
          unlinkSync(join(SESS_DIR, f));
          n++;
        }
    } catch {}
    process.stdout.write(T.muted(`Cleared ${n} session${n === 1 ? "" : "s"}.\n`));
    return;
  }
  const name = args[0];
  if (!name) {
    process.stdout.write(T.muted("usage: nithi forget NAME | --all\n"));
    return;
  }
  try {
    unlinkSync(sessFile(name));
    process.stdout.write(T.muted(`Forgot session "${name}".\n`));
  } catch {
    process.stdout.write(T.muted(`No session "${name}".\n`));
  }
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const a = process.argv;
  if (a.length === 3 && a[2] === "serve") return runDaemon();
  if (a.length === 3 && a[2] === "stop") return stopDaemon();
  if (a.length === 3 && a[2] === "status") return daemonStatus();
  if (a[2] === "forget") return forgetSessions(a.slice(3));

  if (OPTS.help) return printHelp();
  if (OPTS.list) return printSessions();

  const interactive =
    OPTS.interactive || (!OPTS.question && process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) await runInteractive();
  else await runOnce();
}

main().catch((err) => {
  process.stderr.write("\r\x1b[2K");
  console.error(T.tag("Error: ") + (err?.message || String(err)));
  process.exit(1);
});
