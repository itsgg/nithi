// Type-only: importing playwright for real costs about two seconds, and most
// nithi invocations (--help, --list, export, completions, status) never launch a
// browser at all. The runtime import is deferred into start().
import type { Browser, BrowserContext, Page } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DIR_MODE, STATE_FILE } from "./paths.js";
import { parseRun } from "./protocol.js";

const BASE = "https://ask.nithyananda.ai/";
const ORIGIN = "https://ask.nithyananda.ai";
const API = "https://ask.nithyananda.ai/v1/agents/ngpt-v4/runs";

// Opening the site is the one step that depends on someone else's network. A
// single slow load used to kill the daemon outright, so it gets a few tries.
// The whole budget (attempts, timeouts and backoff) stays inside the client's
// own ask timeout, so a cold start is something a waiting question survives
// rather than something it gives up on.
/** A positive number from the environment, or the default for anything else. */
export const positiveEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const NAV_TIMEOUT_MS = positiveEnv("NITHI_NAV_TIMEOUT_MS", 30_000);
const NAV_ATTEMPTS = Math.floor(positiveEnv("NITHI_NAV_ATTEMPTS", 3));
const NAV_BACKOFF_MS = [2_000, 5_000];
const UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";

const HEADLESS = () => !process.env.HEADFUL;

export interface Answer {
  content: string;
  sessionId?: string;
}

/** What the daemon needs from a backend; a fake stands in for this in tests. */
export interface Engine {
  start(): Promise<void>;
  askStream(
    message: string,
    sessionId?: string,
    onContent?: (piece: string) => void,
  ): Promise<Answer>;
  /**
   * Discard whatever state a question may have left behind and come back
   * usable. Called when the daemon abandons an answer, so the next question
   * cannot share a page with a call that is still running.
   */
  recover?(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Playwright reports a dead page, context or browser through a family of
 * messages rather than a typed error. The daemon is long-lived (it runs as a
 * systemd service), so a page that dies once must not wedge every later
 * question: recognising these is what lets askStream relaunch and retry.
 *
 * The patterns are deliberately anchored to Playwright's own wording. A loose
 * /has been closed/ would also match an in-page stream error raised while the
 * page is alive, sending a question that is already streaming down the retry
 * path.
 */
export function isDeadTarget(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  return (
    /Target (page, context or browser has been closed|closed|crashed)/i.test(m) ||
    /(Browser|Page|Browser context) has been closed/i.test(m) ||
    /browserContext\.newPage: Browser closed/i.test(m) ||
    /Protocol error.*(Target closed|Session closed|Connection closed)/i.test(m) ||
    /Execution context was destroyed/i.test(m) ||
    /page\.evaluate: (Target|Execution context|Page closed)/i.test(m)
  );
}

/**
 * Routes streamed chunks to the question that is currently being answered.
 *
 * The daemon can abandon a slow answer (its ask timeout) and start the next one
 * on this same page. The abandoned in-page fetch keeps running and keeps
 * calling back, so every chunk carries the token of the question it belongs to
 * and anything from an older one is dropped rather than spliced into the new
 * answer.
 */
export class DeltaRouter {
  private token = 0;
  private sink?: (chunk: string) => void;

  /** Start routing to `sink`, returning the token that identifies this question. */
  begin(sink: (chunk: string) => void): number {
    this.sink = sink;
    return ++this.token;
  }

  route(token: number, chunk: string): void {
    if (token === this.token) this.sink?.(chunk);
  }

  /** Is `token` still the question being answered? */
  isCurrent(token: number): boolean {
    return token === this.token;
  }

  /** Stop routing, if `token` is still the current question. */
  end(token: number): void {
    if (token === this.token) this.sink = undefined;
  }

  /** Invalidate every outstanding question (the page they belong to is gone). */
  invalidate(): void {
    this.token++;
    this.sink = undefined;
  }
}

export interface Navigation {
  /** Navigate to the site. Rejects on timeout. */
  goto: () => Promise<void>;
  /** Can we run a same-origin fetch from the page as it stands? */
  usable: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  attempts?: number;
  backoffMs?: (attempt: number) => number;
  /** Errors that mean "stop now", rather than "try again". */
  fatal?: (e: unknown) => boolean;
}

/**
 * Open the site, tolerating a slow first load.
 *
 * A `goto` timeout does not mean the page is unusable: waitUntil resolves on a
 * lifecycle event, so a slow subresource or a redirect chain can blow the
 * deadline while the document is already there and perfectly able to issue the
 * same-origin fetch that is all this program needs. So every failure is checked
 * against what we actually require before it is treated as one, and only a page
 * that is genuinely unreachable after several tries is fatal.
 */
export async function openSite(nav: Navigation): Promise<"navigated" | "usable" > {
  const attempts = Math.max(1, Math.floor(nav.attempts ?? NAV_ATTEMPTS));
  const backoff = nav.backoffMs ?? ((i: number) => NAV_BACKOFF_MS[i] ?? NAV_BACKOFF_MS.at(-1)!);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await nav.goto();
      return "navigated";
    } catch (e) {
      // Some failures are not worth retrying: by the time we got here the page
      // may belong to a different question entirely.
      if (nav.fatal?.(e)) throw e;
      last = e;
      // A usability check that cannot run is not evidence of a usable page, but
      // it is no reason to stop trying to open one either.
      const usable = await nav.usable().catch(() => false);
      if (usable) return "usable";
      if (i < attempts - 1) await nav.sleep(backoff(i));
    }
  }
  const why = (last as Error)?.message ?? String(last);
  const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
  throw new Error(`could not open ${BASE} after ${tries}: ${why}`);
}

/** Raised when a question is abandoned before it finished (the ask timed out). */
export class SupersededError extends Error {
  constructor() {
    super("question was superseded by a later one");
  }
}

export class Nithi implements Engine {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private router = new DeltaRouter();
  private lastPersist = 0;

  async start(): Promise<void> {
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: HEADLESS() });
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
    await this.page.exposeFunction("__nithiDelta", (token: number, chunk: string) =>
      this.router.route(token, chunk),
    );
    const how = await this.open(this.page);
    if (how === "usable") {
      // Worth saying out loud: the load never finished, we are going ahead on a
      // page that can still talk to the API. In the daemon this lands in the
      // journal, which is where you look when answers start coming back slowly.
      process.stderr.write("nithi: site load did not complete; continuing on a usable page\n");
    }
    await this.persist(true);
  }

  /**
   * Navigate to the site, with the retry policy above.
   *
   * Bound to one page, and re-checked before every attempt. Retrying takes
   * seconds, long enough for the daemon to abandon this question and hand the
   * browser to the next one; without the check, a retry from a question nobody
   * is waiting for would navigate the page that replaced it.
   */
  private open(page: Page): Promise<"navigated" | "usable"> {
    return openSite({
      goto: async () => {
        if (page !== this.page) throw new SupersededError();
        await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      },
      usable: () => (page === this.page ? this.pageUsable() : Promise.resolve(false)),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      fatal: (e) => e instanceof SupersededError,
    });
  }

  /**
   * Is the page able to do the only thing we ask of it: a same-origin fetch?
   *
   * That means being on the site's origin with a live execution context. A
   * Cloudflare interstitial satisfies both, and deliberately counts as usable:
   * askStream already reloads and re-solves a challenge when a question comes
   * back 403, so refusing to start would be failing over a case that is already
   * handled a layer down.
   */
  private async pageUsable(): Promise<boolean> {
    try {
      if (!this.page || this.page.isClosed()) return false;
      // An origin comparison, not a prefix match: "ask.nithyananda.ai.example"
      // and "ask.nithyananda.ai@example" both start with the origin string.
      if (new URL(this.page.url()).origin !== ORIGIN) return false;
      return await this.page.evaluate(() => typeof fetch === "function");
    } catch {
      return false;
    }
  }

  /** True while the browser, context and page are all still usable. */
  alive(): boolean {
    return !!this.browser?.isConnected() && !!this.page && !this.page.isClosed();
  }

  /**
   * Replace the browser after an abandoned answer. The call that was abandoned
   * may still be running; a fresh page means it cannot reach the one the next
   * question will use, and invalidating its token means every path it can still
   * take stops at a SupersededError.
   */
  recover(): Promise<void> {
    return this.restart();
  }

  /** Tear down whatever is left and bring a fresh browser up. */
  async restart(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // the browser is already gone, which is why we are here
    }
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.router.invalidate(); // anything in flight against the old page is stale
    await this.start();
  }

  /**
   * Stream the answer from the agent API via an in-page fetch (same-origin, so
   * it carries the Cloudflare clearance). Calls onContent with each text delta
   * and returns the full answer plus the session_id.
   *
   * Two recoveries live here, each taken at most once per question:
   *   - a dead page or browser: relaunch and ask again
   *   - a stale Cloudflare clearance: reload to re-solve, then ask again
   */
  async askStream(
    message: string,
    sessionId?: string,
    onContent: (piece: string) => void = () => {},
    attempt: { relaunched?: boolean; challenged?: boolean } = {},
  ): Promise<Answer> {
    if (!this.alive()) {
      if (attempt.relaunched) throw new Error("browser is not available");
      attempt.relaunched = true;
      await this.restart();
    }

    // The SSE buffer belongs to this question, not to the object. An abandoned
    // question can still be running against the same page, and a shared buffer
    // would let it consume or clear part of the current answer.
    const sse = { rest: "" };
    // Retrying is only safe while nothing has reached the caller yet. Once a
    // delta has been printed, asking again would replay the answer on top of
    // the text already on screen and record the question twice upstream, so a
    // late failure is surfaced rather than retried.
    let emitted = false;
    const emit = (piece: string) => {
      emitted = true;
      onContent(piece);
    };
    const token = this.router.begin((chunk) => this.feed(sse, chunk, emit));

    let res: { status: number; text: string };
    try {
      res = await this.evaluateAsk(message, sessionId, token);
    } catch (e) {
      // A question the caller has already given up on must not restart the
      // browser: the page now belongs to whatever question came after it.
      if (!this.router.isCurrent(token)) throw new SupersededError();
      this.router.end(token);
      if (isDeadTarget(e) && !attempt.relaunched && !emitted) {
        attempt.relaunched = true;
        await this.restart();
        // restart() invalidates every outstanding question, including this one,
        // so re-establish that we are still the question being answered before
        // taking a fresh token.
        return this.askStream(message, sessionId, onContent, attempt);
      }
      throw e;
    }
    // Everything past here touches shared state (the page, the clearance file),
    // so a superseded question stops now.
    if (!this.router.isCurrent(token)) throw new SupersededError();
    // Emit a final SSE event that arrived without its trailing newline.
    this.flushFeed(sse, emit);
    this.router.end(token);

    if (res.status !== 200) {
      const challenged =
        res.status === 403 ||
        res.status === 0 ||
        /just a moment|cloudflare|cf-mitigated/i.test(res.text);
      // Stale clearance: reload to re-solve the challenge, then retry once.
      if (challenged && !attempt.challenged && !emitted) {
        attempt.challenged = true;
        const page = this.page!;
        // Same policy as startup: a slow reload is not a reason to give up on a
        // clearance that a second attempt usually refreshes. Bound to this page,
        // so an abandoned retry cannot navigate its replacement.
        await this.open(page).catch(() => {});
        // Re-solving the challenge takes seconds, long enough for this question
        // to be abandoned and the page to be handed to another one. Bail rather
        // than reload and re-ask on a page that is no longer ours.
        if (page !== this.page) throw new SupersededError();
        await this.persist(true);
        return this.askStream(message, sessionId, onContent, attempt);
      }
      const hint = challenged
        ? " (Cloudflare challenge - wait a moment, or run once with HEADFUL=1)"
        : "";
      throw new Error(`request failed: HTTP ${res.status}${hint}`);
    }
    // A refreshed clearance is worth keeping, but not worth a disk write per
    // question: persist at most every few minutes.
    await this.persist(false);
    return parseRun(res.text);
  }

  private evaluateAsk(message: string, sessionId: string | undefined, token: number) {
    return this.page!.evaluate(
      async ({ url, message, sessionId, token }) => {
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
          (window as unknown as { __nithiDelta: (t: number, c: string) => void }).__nithiDelta(
            token,
            chunk,
          );
        }
        return { status: 200, text: full };
      },
      { url: API, message, sessionId: sessionId ?? "", token },
    );
  }

  // Incrementally parse the SSE buffer, emitting each RunContent text delta.
  private feed(sse: { rest: string }, chunk: string, onContent: (piece: string) => void): void {
    sse.rest += chunk;
    let i: number;
    while ((i = sse.rest.indexOf("\n")) >= 0) {
      const line = sse.rest.slice(0, i).trim();
      sse.rest = sse.rest.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.event === "RunContent" && typeof j.content === "string") onContent(j.content);
      } catch {
        // partial or non-JSON line
      }
    }
  }

  /** Emit a trailing SSE event that never got its newline, then drop the buffer. */
  private flushFeed(sse: { rest: string }, onContent: (piece: string) => void): void {
    const line = sse.rest.trim();
    sse.rest = "";
    if (!line.startsWith("data:")) return;
    try {
      const j = JSON.parse(line.slice(5).trim());
      if (j.event === "RunContent" && typeof j.content === "string") onContent(j.content);
    } catch {
      // an incomplete final line is simply dropped
    }
  }

  async persist(force: boolean): Promise<void> {
    if (!force && Date.now() - this.lastPersist < 5 * 60_000) return;
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true, mode: DIR_MODE });
      await this.context!.storageState({ path: STATE_FILE });
      this.lastPersist = Date.now();
    } catch {
      // non-fatal
    }
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // already gone
    }
  }
}
