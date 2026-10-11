#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as readline from "node:readline/promises";
import { spawn } from "node:child_process";

import { parseArgs, UsageError, type Opts } from "./args.js";
import { CACHE, DIR_MODE, DLOG, DPID, FILE_MODE, SESS_DIR, SOCK, STATE_FILE } from "./paths.js";
import { ESC, T, bold, cols, dim, promptMark, setPlain } from "./theme.js";
import { render, turnRule } from "./render.js";
import { createMarkdownStream, createStreamRender } from "./stream.js";
import { buildMessage, extractAtFiles } from "./protocol.js";
import {
  exportSessionMarkdown,
  forgetAllSessions,
  forgetSession,
  latestSession,
  listSessions,
  loadSession,
  newSession,
  updateSession,
  type Session,
} from "./session.js";
import { Nithi, type Answer } from "./browser.js";

/** An answer, plus the turn number it was recorded as when there was a session. */
interface Recorded extends Answer {
  turn?: number;
}

/**
 * The answer stopped part way, and what arrived is on screen and in the
 * transcript. Carries the turn number so the boundary drawn afterwards can
 * name the turn that really was recorded.
 */
export class CutShortError extends Error {
  constructor(
    message: string,
    readonly turn?: number,
  ) {
    super(message);
  }
}
import { clipboardCopy, editorCompose } from "./system.js";
import {
  DEFAULT_TIMEOUT_MS,
  daemonAsk,
  daemonRequest,
  pingDaemon,
  startDaemon,
} from "./daemon.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// nithi - ask Nithyananda (ask.nithyananda.ai) from your terminal.
// Modes: one-shot, piped stdin, and an interactive REPL. Supports named
// sessions with real conversation memory and file attachments.
// ---------------------------------------------------------------------------

// Defaulted rather than merely declared, so importing this module leaves it in
// a sane state. main() replaces it with the real arguments; a test can drive the
// flows without it being undefined underfoot.
let OPTS: Opts = parseArgs([]);
const timeoutMs = () => (OPTS.timeout ? OPTS.timeout * 1000 : DEFAULT_TIMEOUT_MS);

// --- output helpers --------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spinner(label = "thinking") {
  if (OPTS.quiet || OPTS.json || !process.stderr.isTTY) return { stop() {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stderr.write("\r" + T.accent(frames[i++ % frames.length]) + T.muted(" " + label + "…"));
  }, 80);
  id.unref?.();
  return {
    stop() {
      clearInterval(id);
      process.stderr.write("\r" + ESC + "2K");
    },
  };
}

/**
 * Progressive renderer: prints completed blocks (formatted) as they stream in,
 * append-only so nothing on screen is ever rewritten (no flicker), and shows a
 * dim single-line ticker of the in-progress block below them.
 */
/** Wires the progressive renderer to this invocation's flags and streams. */
function streamRender(label?: string) {
  if (OPTS.markdown) return createMarkdownStream();
  return createStreamRender({
    label,
    json: OPTS.json,
    ticker: !OPTS.quiet && !OPTS.json && process.stderr.isTTY,
  });
}

const say = (s: string) => process.stdout.write(s);
const note = (s: string) => process.stdout.write(T.muted(s));

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// --- transport -------------------------------------------------------------

interface Transport {
  ask(
    message: string,
    sessionId?: string,
    onContent?: (piece: string) => void,
  ): Promise<Answer>;
  close(): Promise<void>;
}

class DaemonTransport implements Transport {
  ask(message: string, sessionId?: string, onContent?: (piece: string) => void) {
    return daemonAsk({ op: "ask", message, sessionId }, onContent ?? (() => {}), timeoutMs());
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

/**
 * Start a daemon in the background if one is not already answering. The daemon
 * binds its socket before launching the browser, so a pong means "a daemon owns
 * this socket", and the question that follows simply queues until the browser
 * is warm.
 */
async function ensureDaemon(): Promise<void> {
  if (await pingDaemon()) return;
  mkdirSync(CACHE, { recursive: true, mode: DIR_MODE });
  const log = openSync(DLOG, "a");
  const child = spawn(process.execPath, [process.argv[1], "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await pingDaemon()) return;
    // A child that has exited (cleanly, or killed by a signal) is never going
    // to answer; waiting out the full deadline just delays the fallback.
    if (child.exitCode !== null || child.signalCode !== null) {
      if (await pingDaemon()) return; // another daemon won the race and serves
      const how =
        child.signalCode !== null ? `killed by ${child.signalCode}` : `exited with code ${child.exitCode}`;
      throw new Error(`daemon ${how} (see ${DLOG})`);
    }
  }
  throw new Error("daemon did not start (see " + DLOG + ")");
}

async function makeTransport(): Promise<Transport> {
  if (!process.env.NITHI_NO_DAEMON) {
    const spin = spinner("connecting");
    try {
      await ensureDaemon();
      return new DaemonTransport();
    } catch {
      // fall through to a browser in this process
    } finally {
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

export async function askAndRecord(
  tx: Transport,
  session: Session | null,
  question: string,
  files: string[],
  label?: string,
): Promise<Recorded> {
  const sr = streamRender(label);
  sr.begin();
  try {
    const useSession = session && !OPTS.fresh ? session.sessionId : undefined;
    const system = OPTS.system ?? session?.system;
    const answer = await tx.ask(buildMessage(question, files, system), useSession, (piece) =>
      sr.push(piece),
    );
    sr.finish(answer.content);
    if (session) {
      // Read, append and write as one locked step, so a second nithi answering
      // into the same session cannot overwrite this turn (or resurrect one that
      // /retry just dropped).
      const turn = { q: question, a: answer.content, at: Date.now() };
      // The session passed to the callback is loaded from disk inside the lock,
      // so it is authoritative: appending to it, rather than to the copy this
      // process has been holding, is what stops a concurrent turn being lost or
      // a turn another process just dropped being written back.
      const saved = updateSession(session.name, (s) => {
        s.turns.push(turn);
        if (answer.sessionId) s.sessionId = answer.sessionId;
        if (OPTS.system) s.system = OPTS.system;
      });
      Object.assign(session, saved);
      // The turn's own number, taken from the transcript that was actually
      // written. Comparing lengths before and after would miscount whenever
      // another process removed a turn while this answer was in flight.
      return { ...answer, turn: saved.turns.length };
    }
    return answer;
  } catch (e) {
    // The reader may already be looking at half an answer. Keeping it, saying
    // it was cut short, and recording it as such is the only way the screen and
    // the transcript agree about what happened; dropping it left text on screen
    // that /history and an export both denied ever existed.
    // In --markdown, what the stream still held (a card not yet closed) goes
    // out first, so the fragment the reader keeps is all that arrived
    // (Cursor 2026-10-11); then it ends with a newline.
    const held = sr as { release?: () => void };
    if (OPTS.markdown) held.release?.();
    const shown = sr.shown().trim();
    if (!shown) throw e;
    if (OPTS.markdown && !sr.shown().endsWith("\n")) say("\n");
    let turn: number | undefined;
    if (session) {
      const saved = updateSession(session.name, (s) => {
        s.turns.push({ q: question, a: shown, at: Date.now(), partial: true });
        if (OPTS.system) s.system = OPTS.system;
      });
      Object.assign(session, saved);
      turn = saved.turns.length;
    }
    throw new CutShortError(`the answer above was cut short: ${(e as Error).message}`, turn);
  } finally {
    sr.stop();
  }
}

async function runOnce(): Promise<void> {
  const question = OPTS.question || (await readStdin());
  // Machine output is the answer or nothing: a caller reading --json or
  // --markdown must not get the help page as an answer.
  if (!question && (OPTS.json || OPTS.markdown)) throw new UsageError("no question: give one, or pipe it in");
  if (!question) {
    printHelp();
    process.exit(2);
  }
  const session = resolveSession();
  const tx = await makeTransport();
  try {
    const answer = await askAndRecord(tx, session, question, OPTS.files);
    if (OPTS.json)
      say(
        JSON.stringify(
          {
            question,
            content: answer.content,
            sessionId: answer.sessionId ?? null,
            session: session?.name ?? null,
          },
          null,
          2,
        ) + "\n",
      );
  } finally {
    await tx.close();
  }
}

// --- REPL ------------------------------------------------------------------

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "");

async function runInteractive(): Promise<void> {
  let session = resolveSession() || newSession("chat-" + stamp());

  const tx = await makeTransport();

  say(
    T.h1(bold("Ask Nithyananda")) +
      T.muted("  session: " + session.name) +
      (session.turns.length ? T.muted(`  (${session.turns.length} prior turns)`) : "") +
      "\n" +
      T.muted("Type a question. /help for commands, /exit to quit.") +
      "\n",
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Two speakers, named asymmetrically. The prompt used to read "nithi ▸ " in
  // front of what the user types, which is the one label on screen and it named
  // the wrong party.
  const YOU = "you";
  const NITHI = "nithi";
  // Chrome is for a person reading a terminal. A piped or --raw session gets the
  // bare conversation, so nothing new lands in a file or a pipe.
  const chrome = !OPTS.raw && !OPTS.json && process.stdout.isTTY;
  // The name stays even when the chrome is off (it says who is typing, which is
  // the point), but the navigation escape follows the same gate as the label and
  // the rule, so --raw and a redirected session emit no escapes.
  const prompt = () => (chrome ? promptMark() : "") + T.accent(YOU + " ▸ ");

  /**
   * Closes a turn. Deliberately heavier and wider than the rule renderMarkdown
   * draws for a `---` inside an answer, because the two used to be identical and
   * the only strong line on screen marked a place that was not a boundary.
   *
   * Drawn after an answer rather than before a prompt: what the next line will
   * be is unknowable at prompt time, and a rule announcing a turn that turned
   * out to be `/help` numbered the conversation wrongly.
   */
  const closeTurn = (n?: number) => {
    if (!chrome) return;
    say("\n" + turnRule(cols(), n) + "\n");
  };

  const ask = async (text: string, files: string[]) => {
    let turn: number | undefined;
    try {
      turn = (await askAndRecord(tx, session, text, files, chrome ? NITHI : undefined)).turn;
    } catch (e) {
      // A cut-short answer was still recorded, so the boundary names its turn:
      // an unnumbered rule would say nothing was kept when something was.
      if (e instanceof CutShortError) turn = e.turn;
      say(T.tag("! ") + (e as Error).message + "\n");
    } finally {
      // In the finally so /retry and /edit, which also produce a turn, close it
      // the same way a typed question does, and so a question that failed is
      // still separated from the next one. A failed question recorded no turn,
      // so it closes without a number rather than claiming one.
      closeTurn(turn);
    }
  };

  if (OPTS.question) {
    say(prompt() + OPTS.question + "\n");
    await ask(OPTS.question, OPTS.files);
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
      const rest = args.join(" ");
      const last = session.turns[session.turns.length - 1];
      switch (cmd) {
        case "exit":
        case "quit":
        case "q":
          running = false;
          break;
        case "new":
          session = newSession("chat-" + stamp());
          note("Started new session: " + session.name + "\n");
          break;
        case "session":
          if (!rest) note("Current session: " + session.name + "\n");
          else {
            session = loadSession(rest) || newSession(rest);
            note(`Switched to "${session.name}" (${session.turns.length} turns)\n`);
          }
          break;
        case "sessions":
          printSessions();
          break;
        case "forget":
          if (!rest) note("usage: /forget NAME\n");
          else note(forgetSession(rest) ? `Forgot "${rest}".\n` : `No session "${rest}".\n`);
          break;
        case "system":
          if (!rest) note("System: " + (session.system || "(none)") + "\n");
          else {
            // Through the same lock as an answer, so setting a note cannot
            // write back a transcript that has moved on.
            const next = rest === "clear" ? undefined : rest;
            Object.assign(
              session,
              updateSession(session.name, (s) => {
                s.system = next;
              }),
            );
            note(next ? "System note set.\n" : "System note cleared.\n");
          }
          break;
        case "history":
          if (!session.turns.length) note("No turns yet.\n");
          for (const t of session.turns) say(T.accent("▸ ") + t.q + "\n" + render(t.a) + "\n\n");
          break;
        case "retry":
          if (!last) note("Nothing to retry yet.\n");
          else {
            // Persist the removal before re-asking, under the same lock the
            // answer will use. Otherwise the transcript on disk still holds the
            // turn we just dropped, and the merge that guards against
            // concurrent writers would faithfully restore it.
            Object.assign(
              session,
              updateSession(session.name, (s) => {
                // Remove the turn being retried specifically, not whatever is
                // last: another process may have appended since.
                const i = s.turns.findIndex((t) => t.at === last.at && t.q === last.q);
                if (i >= 0) s.turns.splice(i, 1);
              }),
            );
            await ask(last.q, []);
          }
          break;
        case "copy":
          if (!last) note("Nothing to copy yet.\n");
          else {
            const via = clipboardCopy(last.a);
            note(via ? `Copied the last answer (${via}).\n` : "No clipboard helper found.\n");
          }
          break;
        case "save":
          if (!rest) note("usage: /save PATH\n");
          else {
            try {
              writeFileSync(rest, exportSessionMarkdown(session), { mode: FILE_MODE });
              note(`Saved ${session.turns.length} turns to ${rest}.\n`);
            } catch (e) {
              note(`Could not write ${rest}: ${(e as Error).message}\n`);
            }
          }
          break;
        case "edit": {
          const text = editorCompose(rest);
          if (text === null) note("Set $EDITOR to compose in an editor.\n");
          else if (!text) note("Nothing to send.\n");
          else {
            const { text: t, files } = extractAtFiles(text);
            await ask(t || text, files);
          }
          break;
        }
        case "clear":
          say("\x1b[2J\x1b[H");
          break;
        case "help":
          printReplHelp();
          break;
        default:
          note("Unknown command. /help for the list.\n");
      }
      continue;
    }

    const { text, files } = extractAtFiles(line);
    await ask(text || line, files);
  }

  rl.close();
  await tx.close();
  note("\nNithyanandam. Session saved as " + session.name + ".\n");
}

// --- daemon commands -------------------------------------------------------

async function runDaemonForeground(): Promise<void> {
  for (;;) {
    const handle = await startDaemon({
      engine: new Nithi(),
      version: VERSION,
      log: (m) => process.stderr.write(m + "\n"),
    });
    if (handle.outcome === "started") {
      await handle.closed;
      return;
    }

    // Another daemon owns the socket. Exiting here is right for a person who
    // typed `nithi serve` twice, but wrong under a supervisor: systemd would
    // see a clean exit, mark the unit inactive, and leave the surviving daemon
    // unmanaged. --wait stands by instead and takes over when it goes away,
    // which is what the CLI's own on-demand daemon eventually does when it
    // idles out.
    if (!OPTS.wait) {
      process.stderr.write(`nithi daemon already running (pid ${handle.pid})\n`);
      return;
    }
    process.stderr.write(
      `another nithi daemon owns the socket (pid ${handle.pid}); standing by\n`,
    );
    while (await pingDaemon()) await sleep(5000);
    process.stderr.write("the other daemon is gone; taking over\n");
  }
}

async function stopDaemon(): Promise<void> {
  const before = await pingDaemon();
  if (!before) {
    note("no daemon running\n");
    return;
  }
  try {
    await daemonRequest({ op: "stop" }, 5000);
  } catch {
    // the daemon may close the socket before replying
  }
  // Confirm rather than announcing on hope.
  for (let i = 0; i < 20; i++) {
    if (!(await pingDaemon(SOCK, 300))) {
      note("daemon stopped\n");
      return;
    }
    await sleep(100);
  }
  note("daemon did not stop; it may be finishing a question\n");
}

async function daemonStatus(): Promise<void> {
  const r = await pingDaemon();
  if (!r) {
    note("○ daemon not running\n");
    return;
  }
  const up = Math.round((Date.now() - (r.started ?? Date.now())) / 1000);
  const state = r.ready ? "" : T.tag(" (browser still starting)");
  say(
    T.accent("● ") +
      "daemon running " +
      T.muted(`(pid ${r.pid}, up ${up}s${r.version ? `, v${r.version}` : ""})`) +
      state +
      "\n",
  );
}

// --- doctor ----------------------------------------------------------------

async function doctor(): Promise<void> {
  const rows: [boolean | null, string, string][] = [];
  const add = (ok: boolean | null, label: string, detail = "") => rows.push([ok, label, detail]);

  const [maj] = process.versions.node.split(".").map(Number);
  add(maj >= 18, "node " + process.versions.node, maj >= 18 ? "" : "nithi needs Node 18 or newer");

  add(true, "nithi " + VERSION, process.argv[1]);

  // Playwright's chromium download is the one install step npm cannot do.
  let browserOk = false;
  let browserDetail = "run: npx playwright install chromium";
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    browserOk = existsSync(path);
    if (browserOk) browserDetail = path;
  } catch (e) {
    browserDetail = (e as Error).message;
  }
  add(browserOk, "chromium", browserDetail);

  const dirOk = existsSync(CACHE);
  let dirDetail = CACHE;
  if (dirOk) {
    const mode = statSync(CACHE).mode & 0o777;
    dirDetail = `${CACHE} (mode ${mode.toString(8)})`;
    if (mode & 0o077) dirDetail += ` - readable by other local users; fix with: chmod 700 ${CACHE}`;
  }
  add(dirOk ? !(statSync(CACHE).mode & 0o077) : null, "cache dir", dirDetail);

  add(existsSync(STATE_FILE), "cloudflare clearance", existsSync(STATE_FILE) ? STATE_FILE : "none saved yet (first run will make one)");

  const sessions = listSessions();
  add(true, "sessions", `${sessions.length} saved in ${SESS_DIR}`);

  const pong = await pingDaemon();
  if (pong) {
    const perm = existsSync(SOCK) ? statSync(SOCK).mode & 0o777 : 0;
    add(true, "daemon", `pid ${pong.pid}, ${pong.ready ? "ready" : "starting"}, socket mode ${perm.toString(8)}`);
    if (perm & 0o077) add(false, "socket permissions", "other local users can connect to your daemon");
  } else {
    add(null, "daemon", "not running (it starts on demand)");
  }

  // A reachability check that does not need the browser.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://ask.nithyananda.ai/", {
      method: "HEAD",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    add(res.status < 500, "ask.nithyananda.ai", `HTTP ${res.status}` + (res.status === 403 ? " (Cloudflare; expected without a browser)" : ""));
  } catch (e) {
    add(false, "ask.nithyananda.ai", (e as Error).message);
  }

  const mark = (ok: boolean | null) =>
    ok === null ? T.muted("○") : ok ? T.accent("✓") : T.tag("✗");
  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [ok, label, detail] of rows)
    say(`${mark(ok)} ${bold(label.padEnd(w))}  ${T.muted(detail)}\n`);
}

// --- completions -----------------------------------------------------------

const FLAGS = [
  "--session",
  "--continue",
  "--new",
  "--file",
  "--system",
  "--timeout",
  "--interactive",
  "--list",
  "--raw",
  "--json",
  "--markdown",
  "--quiet",
  "--help",
  "--version",
];
const SUBCOMMANDS = ["serve", "stop", "status", "forget", "export", "doctor", "completions"];
const SERVE_FLAGS = ["--wait"];

function printCompletions(shell: string): void {
  const words = [...SUBCOMMANDS, ...FLAGS, ...SERVE_FLAGS].join(" ");
  if (shell === "bash") {
    say(`# nithi bash completion: eval "$(nithi completions bash)"
_nithi() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    -s|--session) COMPREPLY=( $(compgen -W "$(nithi --list 2>/dev/null | sed -n 's/^. \\([^ ]*\\) .*/\\1/p')" -- "$cur") ); return;;
    -f|--file) COMPREPLY=( $(compgen -f -- "$cur") ); return;;
    completions) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return;;
  esac
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
}
complete -F _nithi nithi
`);
    return;
  }
  if (shell === "zsh") {
    say(`# nithi zsh completion: eval "$(nithi completions zsh)"
_nithi() {
  local -a subs flags
  subs=(${SUBCOMMANDS.map((s) => `'${s}'`).join(" ")})
  flags=(${FLAGS.map((f) => `'${f}'`).join(" ")})
  case "\${words[CURRENT-1]}" in
    -s|--session) compadd \${(f)"$(nithi --list 2>/dev/null | sed -n 's/^. \\([^ ]*\\) .*/\\1/p')"}; return;;
    -f|--file) _files; return;;
    completions) compadd bash zsh fish; return;;
  esac
  compadd -a subs flags
}
compdef _nithi nithi
`);
    return;
  }
  if (shell === "fish") {
    const lines = [
      "# nithi fish completion: nithi completions fish > ~/.config/fish/completions/nithi.fish",
      ...SUBCOMMANDS.map((s) => `complete -c nithi -n __fish_use_subcommand -a ${s}`),
      ...FLAGS.map((f) => `complete -c nithi -l ${f.replace(/^--/, "")}`),
      "complete -c nithi -s f -l file -r -F",
      "complete -c nithi -s s -l session -x -a \"(nithi --list 2>/dev/null | string replace -r '^. ([^ ]*) .*' '$1')\"",
    ];
    say(lines.join("\n") + "\n");
    return;
  }
  throw new UsageError(`unknown shell: ${shell} (try bash, zsh or fish)`);
}

// --- help / listings -------------------------------------------------------

function printHelp(): void {
  const b = (s: string) => bold(s);
  say(
    `${T.h1(bold("nithi"))} ${T.muted("- ask Nithyananda from your terminal")} ${T.muted("v" + VERSION)}

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
  -t, --timeout SECONDS   give up on an answer after this long
  -i, --interactive       open the REPL (asks the given question first)
      --list              list saved sessions
      --raw               plain text, no color or markdown styling
      --json              print one JSON object instead of a rendered answer
      --markdown          the answer as raw Markdown, written as it arrives,
                          its cards as Markdown too
  -q, --quiet             no spinner or progress ticker
  -h, --help              show this help
  -V, --version           show the version

${b("Sessions")}
  nithi --list            list saved sessions
  nithi export NAME       print a session as markdown
  nithi export NAME --json   print a session as JSON
  nithi forget NAME       delete a session
  nithi forget --all      delete all sessions

${b("Daemon")} ${T.muted("(a warm browser reused across calls; auto-started)")}
  nithi status            is the daemon running?
  nithi stop              stop the daemon
  nithi serve             run the daemon in the foreground
  nithi serve --wait      ...and stand by if another daemon owns the socket
  nithi doctor            check the install, browser, cache and connectivity

${b("Shell")}
  nithi completions bash|zsh|fish

${b("In the REPL")} ${T.muted("(you ▸ asks, nithi answers, a numbered rule closes each turn)")}
  @path in a message      attach a file
  /session [NAME]         show or switch/resume a session
  /sessions               list saved sessions
  /system [TEXT|clear]    show/set/clear a steering instruction
  /new                    start a new session
  /retry                  ask the last question again
  /edit [TEXT]            compose the message in $EDITOR
  /copy                   copy the last answer to the clipboard
  /save PATH              write the session to a markdown file
  /history                replay this session's turns
  /forget NAME            delete a saved session
  /clear                  clear the screen
  /exit                   quit

${b("Env")}
  HEADFUL=1  NO_COLOR=1  FORCE_COLOR=1  NO_HYPERLINKS=1
  NITHI_NO_DAEMON=1  NITHI_IDLE_MIN=15  NITHI_HOME=~/.cache/nithi
`,
  );
}

function printReplHelp(): void {
  note(
    [
      "  @path                  attach a file to the message",
      "  /session [NAME]        show or switch/resume a session",
      "  /sessions              list saved sessions",
      "  /system [TEXT|clear]   show/set/clear a steering instruction",
      "  /new                   start a new session",
      "  /retry                 ask the last question again",
      "  /edit [TEXT]           compose the message in $EDITOR",
      "  /copy                  copy the last answer to the clipboard",
      "  /save PATH             write the session to a markdown file",
      "  /history               replay this session's turns",
      "  /forget NAME           delete a saved session",
      "  /clear                 clear the screen",
      "  /exit                  quit",
    ].join("\n") + "\n",
  );
}

function printSessions(): void {
  const sessions = listSessions();
  if (!sessions.length) {
    note("No saved sessions.\n");
    return;
  }
  for (const s of sessions) {
    const when = new Date(s.updatedAt).toLocaleString();
    say(T.accent("• ") + bold(s.name) + T.muted(`  ${s.turns.length} turns  ${when}`) + "\n");
    const last = s.turns[s.turns.length - 1];
    if (last) note("    last: " + last.q.slice(0, 70) + "\n");
  }
}

function exportSession(args: string[]): void {
  for (const a of args)
    if (a.startsWith("-") && a !== "--json") throw new UsageError(`unknown option: ${a}`);
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) throw new UsageError("usage: nithi export NAME [--json]");
  const s = loadSession(name);
  if (!s) throw new UsageError(`no session "${name}"`);
  say(args.includes("--json") ? JSON.stringify(s, null, 2) + "\n" : exportSessionMarkdown(s));
}

function forgetSessions(args: string[]): void {
  if (args[0] === "--all") {
    const n = forgetAllSessions();
    note(`Cleared ${n} session${n === 1 ? "" : "s"}.\n`);
    return;
  }
  for (const a of args)
    if (a.startsWith("-")) throw new UsageError(`unknown option: ${a}`);
  const name = args[0];
  if (!name) throw new UsageError("usage: nithi forget NAME | --all");
  note(forgetSession(name) ? `Forgot session "${name}".\n` : `No session "${name}".\n`);
}

// --- main ------------------------------------------------------------------

export async function main(argv = process.argv): Promise<void> {
  const args = argv.slice(2);

  // Subcommands are matched on the first argument only, so their own flags may
  // follow. The daemon commands accept the general flags (--raw, --quiet);
  // export and forget take only their own, so their arguments are read directly.
  const sub = args[0];
  if (sub === "serve" || sub === "stop" || sub === "status" || sub === "doctor") {
    OPTS = parseArgs(args.slice(1));
    setPlain(OPTS.raw || OPTS.json);
    if (sub === "serve") return runDaemonForeground();
    if (sub === "stop") return stopDaemon();
    if (sub === "status") return daemonStatus();
    return doctor();
  }
  if (sub === "completions") {
    OPTS = parseArgs([]);
    setPlain(true);
    return printCompletions(args[1] ?? "");
  }
  if (sub === "export") {
    OPTS = parseArgs([]);
    setPlain(true); // a transcript on stdout is for a file or a pipe
    return exportSession(args.slice(1));
  }
  if (sub === "forget") {
    OPTS = parseArgs([]);
    return forgetSessions(args.slice(1));
  }

  OPTS = parseArgs(args);
  setPlain(OPTS.raw || OPTS.json);

  if (OPTS.help) return printHelp();
  if (OPTS.version) return void say(VERSION + "\n");
  if (OPTS.list) return printSessions();

  const interactive =
    OPTS.interactive || (!OPTS.question && process.stdin.isTTY && process.stdout.isTTY);
  // The REPL has no single object to emit, and --json suppresses the rendered
  // answer, so the combination would show a prompt and nothing else.
  if (interactive && OPTS.json)
    throw new UsageError("--json is for one-shot questions, not the interactive REPL");
  if (interactive && OPTS.markdown)
    throw new UsageError("--markdown is for one-shot questions, not the interactive REPL");
  if (OPTS.json && OPTS.markdown) throw new UsageError("--json and --markdown are two ways to print one answer: pick one");
  if (interactive) await runInteractive();
  else await runOnce();
}

// Only run when invoked as a program, so the module can be imported by tests.
// argv[1] is resolved through realpath first: `npm link` puts a symlink on PATH,
// and comparing the symlink against the module's real URL never matches.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write("\r" + ESC + "2K");
    const usage = err instanceof UsageError;
    process.stderr.write(T.tag(usage ? "" : "Error: ") + (err?.message || String(err)) + "\n");
    if (usage) process.stderr.write(T.muted("Try `nithi --help`.\n"));
    process.exit(usage ? 2 : 1);
  });
}
