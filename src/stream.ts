import { ESC, T, cols } from "./theme.js";
import { closeCard, markdownOf, openuiMarkdown, reconcileTail, render, safeCut } from "./render.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface StreamOptions {
  /** Name shown once above the first block of the answer. Omitted for one-shot output. */
  label?: string;
  /** --json emits a single object at the end, so nothing may be written before it. */
  json?: boolean;
  /** Whether to animate progress. False for --quiet, and whenever stderr is not a terminal. */
  ticker?: boolean;
  /** Where the answer goes. */
  out?: (s: string) => void;
  /** Where progress goes, kept off `out` so a redirected answer stays clean. */
  err?: (s: string) => void;
  /** Terminal width, read at each draw so a resize is picked up. */
  width?: () => number;
  /** Injectable clock, so tests need not wait for seconds to pass. */
  now?: () => number;
}

export interface StreamRender {
  begin(): void;
  push(chunk: string): void;
  finish(content: string): void;
  stop(): void;
  /**
   * The text that actually landed on the screen, so a failure can say what
   * survived. Not the deltas received: text still sitting in the buffer when a
   * question fails has only ever appeared in the progress line, which is
   * transient and gets cleared, and text that renders to nothing was never
   * there at all.
   */
  shown(): string;
}

/**
 * Progressive renderer: prints completed blocks as they stream in, append-only
 * so nothing on screen is ever rewritten, with a progress line below them.
 *
 * Everything it touches is injected. This is the fiddliest logic in the program
 * (a label that must appear exactly once, blank-line arithmetic that differs for
 * the first block, and reconciling the streamed text against the authoritative
 * final answer), and it used to reach straight for process.stdout and a module
 * global, which left it impossible to test.
 */
export function createStreamRender(o: StreamOptions = {}): StreamRender {
  const label = o.label;
  const json = o.json ?? false;
  // --json promises a single object and nothing else, so it silences progress
  // here rather than trusting every caller to have combined the two flags.
  const ticker = (o.ticker ?? false) && !json;
  const out = o.out ?? ((s: string) => process.stdout.write(s));
  const err = o.err ?? ((s: string) => process.stderr.write(s));
  const width = o.width ?? cols;
  const now = o.now ?? Date.now;

  let buf = "";
  let printed = 0;
  let streamed = ""; // every delta received, to reconcile against the final text
  let displayed = ""; // only the part of it that actually reached the screen
  let frame = 0;
  let since = 0;
  let beat: NodeJS.Timeout | undefined;
  // Printed once, immediately above the first block of the answer, so the reply
  // is marked by something it has rather than by the absence of a prompt.
  let labelled = false;

  const speaker = () => {
    if (labelled || !label) return;
    labelled = true;
    out("\n" + T.tag(label) + "\n");
  };
  const clearTicker = () => {
    if (ticker) err("\r" + ESC + "2K");
  };
  const stopBeat = () => {
    if (beat) clearInterval(beat);
    beat = undefined;
  };
  const showTicker = () => {
    if (!ticker) return;
    const secs = Math.floor((now() - since) / 1000);
    const tail = buf.replace(/\s+/g, " ").trim();
    // Counted only while nothing has arrived yet, and only once the wait is long
    // enough to wonder about. Answer text arriving is its own evidence of
    // progress. This asks whether anything has ever arrived rather than whether
    // the buffer holds something now: the buffer empties every time a block is
    // flushed, which would bring the clock back between paragraphs.
    const waiting = streamed.trim() === "";
    const elapsed = waiting && secs >= 2 ? ` ${secs}s` : "";
    const glyph = SPIN[frame++ % SPIN.length];
    const room = Math.max(10, width() - 4 - elapsed.length);
    const s = tail.length > room ? "…" + tail.slice(-(room - 1)) : tail || "thinking…";
    err("\r" + ESC + "2K" + T.accent(glyph + " ") + T.muted(s + elapsed));
  };

  /** The blank line above a block. The label already supplies one for the first. */
  const lead = () => (printed === 0 && label ? "" : "\n");

  const flush = (final: boolean) => {
    for (;;) {
      const cut = final ? buf.length : safeCut(buf);
      if (cut <= 0) break;
      const source = buf.slice(0, cut);
      buf = buf.slice(cut);
      const block = render(source);
      if (block) {
        clearTicker();
        speaker();
        out(lead() + block + "\n");
        // The source of a block that was printed, not merely one that was
        // consumed: a fence that renders to nothing reached nobody, and neither
        // did whatever is still sitting in the buffer when a question fails.
        displayed += source;
        printed++;
      }
      if (final) break;
    }
  };

  return {
    /**
     * Acknowledge the question straight away.
     *
     * The progress line used to be redrawn only when a delta arrived, so between
     * pressing Enter and the model's first token the screen showed nothing at
     * all. That gap is routinely five to ten seconds, which reads as a hang
     * rather than as thinking.
     */
    begin() {
      if (!ticker || beat) return;
      since = now();
      showTicker();
      beat = setInterval(showTicker, 100);
      beat.unref?.();
    },
    push(chunk: string) {
      if (json) return;
      streamed += chunk;
      buf += chunk;
      flush(false);
      showTicker();
    },
    finish(content: string) {
      stopBeat();
      if (json) return;
      flush(true);
      clearTicker();
      // No deltas streamed (some responses only carry the final): print it once.
      // Otherwise top up whatever the stream stopped short of.
      const tail = printed === 0 ? (content ?? "").trim() : reconcileTail(streamed, content);
      // Render first, then decide: an answer that is only an empty code fence is
      // non-empty text that renders to nothing, and would otherwise leave a
      // speaker label standing over no answer at all.
      const block = tail.trim() ? render(tail) : "";
      if (block) {
        speaker();
        out(lead() + block + "\n");
        displayed += tail;
        printed++;
      }
    },
    stop() {
      stopBeat();
      clearTicker();
    },
    shown() {
      return displayed;
    },
  };
}

/**
 * The answer as Markdown, written as it arrives, for a program that draws
 * Markdown itself (a launcher's pane): no rendering and no progress line.
 * An <openui> block is held until it closes and written as Markdown
 * (openuiMarkdown); a "<" that may open one is held until it is known not
 * to. `shown` is the answer's own text written so far, cards as the service
 * sent them, which is what a cut-short turn records.
 */
export function createMarkdownStream(out: (s: string) => void = (s) => process.stdout.write(s)): StreamRender {
  let shown = "";
  let held = "";
  let wrote = "";
  const write = (s: string) => {
    if (!s) return;
    wrote += s;
    out(s);
  };
  // A card opens where "<openui" ends a word: "<openuiX" is text (Cursor 2026-10-11).
  const OPEN = /<openui(?=[\s>])/;
  // How much of the end of `s` could still become a card's opening.
  const opening = (s: string) => {
    for (let n = Math.min(s.length, 7); n > 0; n--) if ("<openui ".startsWith(s.slice(-n)) || "<openui>".startsWith(s.slice(-n))) return n;
    return 0;
  };
  // Where the card at the start of `s` closes: the first "</openui>" outside
  // its quoted strings, which may hold that text themselves; -1 while open.
  const closing = (s: string) => {
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted && c === "\\") i++;
      else if (c === '"') quoted = !quoted;
      else if (!quoted && s.startsWith("</openui>", i)) return i + "</openui>".length;
    }
    return -1;
  };
  const drain = () => {
    for (;;) {
      const m = OPEN.exec(held);
      if (!m) {
        const keep = opening(held);
        const go = held.slice(0, held.length - keep);
        write(go);
        shown += go;
        held = held.slice(go.length);
        return;
      }
      if (m.index > 0) {
        write(held.slice(0, m.index));
        shown += held.slice(0, m.index);
        held = held.slice(m.index);
      }
      const end = closing(held);
      if (end < 0) return;
      const block = held.slice(0, end);
      write(openuiMarkdown(block));
      shown += block;
      held = held.slice(end);
    }
  };
  // What is still held, written as it can be: a card that never closed as
  // one that did, anything else as it is.
  const release = () => {
    if (!held) return;
    write(OPEN.test(held) ? markdownOf(closeCard(held)) : held);
    shown += held;
    held = "";
  };
  return {
    begin() {},
    push(chunk: string) {
      held += chunk;
      drain();
    },
    finish(content: string) {
      const full = content ?? "";
      const sent = shown + held;
      if (full.length > sent.length && full.startsWith(sent)) held += full.slice(sent.length);
      drain();
      release();
      if (wrote && !wrote.endsWith("\n")) out("\n");
    },
    stop() {},
    shown() {
      return shown;
    },
    /** An answer cut short: what was held goes out too, so the reader keeps it. */
    release() {
      drain();
      release();
    },
  } as StreamRender & { release(): void };
}
