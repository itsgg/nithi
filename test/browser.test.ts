import { test } from "node:test";
import assert from "node:assert/strict";

const { isDeadTarget, DeltaRouter, openSite } = await import("../src/browser.js");

// These are Playwright's own wordings. Matching them is what lets the daemon
// relaunch a dead browser instead of failing every later question.
const DEAD = [
  "page.evaluate: Target page, context or browser has been closed",
  "Target closed",
  "Target crashed",
  "Browser has been closed",
  "Page has been closed",
  "browserContext.newPage: Browser closed",
  "Protocol error (Runtime.callFunctionOn): Target closed",
  "Protocol error (Page.navigate): Session closed. Most likely the page has been closed.",
  "Execution context was destroyed, most likely because of a navigation",
  "page.evaluate: Execution context was destroyed",
];

for (const msg of DEAD) {
  test(`treated as a dead target: ${msg.slice(0, 48)}`, () => {
    assert.equal(isDeadTarget(new Error(msg)), true);
  });
}

// A live page can raise errors that merely mention closing. Retrying those
// would resend a question whose answer is already streaming to the user.
const ALIVE = [
  "request failed: HTTP 500",
  "TypeError: Failed to fetch",
  "The stream has been closed by the server",
  "ReadableStreamDefaultReader: the reader has been closed",
  "net::ERR_CONNECTION_REFUSED",
  "Timeout 45000ms exceeded",
];

for (const msg of ALIVE) {
  test(`not treated as a dead target: ${msg.slice(0, 48)}`, () => {
    assert.equal(isDeadTarget(new Error(msg)), false);
  });
}

test("isDeadTarget copes with non-Error values", () => {
  assert.equal(isDeadTarget("Target closed"), true);
  assert.equal(isDeadTarget(undefined), false);
  assert.equal(isDeadTarget(null), false);
  assert.equal(isDeadTarget({}), false);
});

// --- delta routing ----------------------------------------------------------
// The daemon can abandon a slow answer and start the next one on the same page.
// The abandoned in-page fetch keeps calling back, and those chunks must not be
// spliced into the answer the user is now reading.

test("chunks reach the question that is currently being answered", () => {
  const r = new DeltaRouter();
  const got: string[] = [];
  const token = r.begin((c) => got.push(c));
  r.route(token, "one");
  r.route(token, "two");
  assert.deepEqual(got, ["one", "two"]);
});

test("chunks from an abandoned question are dropped, not delivered to the next", () => {
  const r = new DeltaRouter();
  const first: string[] = [];
  const second: string[] = [];
  const a = r.begin((c) => first.push(c));
  r.route(a, "a1");
  // the daemon gives up on the first question and starts the next one
  const b = r.begin((c) => second.push(c));
  r.route(b, "b1");
  r.route(a, "late from the abandoned fetch");
  r.route(b, "b2");
  assert.deepEqual(first, ["a1"]);
  assert.deepEqual(second, ["b1", "b2"], "a stale chunk leaked into the current answer");
});

test("ending an already-superseded question does not silence the current one", () => {
  const r = new DeltaRouter();
  const got: string[] = [];
  const a = r.begin(() => {});
  const b = r.begin((c) => got.push(c));
  r.end(a); // the abandoned question finally settles
  r.route(b, "still delivered");
  assert.deepEqual(got, ["still delivered"]);
});

test("ending the current question stops delivery", () => {
  const r = new DeltaRouter();
  const got: string[] = [];
  const t = r.begin((c) => got.push(c));
  r.route(t, "before");
  r.end(t);
  r.route(t, "after");
  assert.deepEqual(got, ["before"]);
});

test("invalidate drops everything outstanding, as a relaunch must", () => {
  const r = new DeltaRouter();
  const got: string[] = [];
  const t = r.begin((c) => got.push(c));
  r.invalidate(); // the page these belong to is gone
  r.route(t, "from the dead page");
  assert.deepEqual(got, []);
});

test("isCurrent distinguishes the live question from an abandoned one", () => {
  const r = new DeltaRouter();
  const a = r.begin(() => {});
  assert.equal(r.isCurrent(a), true);
  const b = r.begin(() => {});
  assert.equal(r.isCurrent(a), false, "an abandoned question still claims to be current");
  assert.equal(r.isCurrent(b), true);
  r.invalidate();
  assert.equal(r.isCurrent(b), false, "a relaunch must invalidate the question in flight");
});

// --- opening the site -------------------------------------------------------
// The one step that depends on someone else's network. A single slow load used
// to kill the daemon outright.

const noSleep = async () => {};

test("a page that opens first time needs no retry", async () => {
  let gotos = 0;
  const r = await openSite({
    goto: async () => void gotos++,
    usable: async () => true,
    sleep: noSleep,
  });
  assert.equal(r, "navigated");
  assert.equal(gotos, 1);
});

test("a slow load is retried rather than being fatal", async () => {
  let gotos = 0;
  const r = await openSite({
    goto: async () => {
      if (++gotos < 3) throw new Error("page.goto: Timeout 30000ms exceeded");
    },
    usable: async () => false,
    sleep: noSleep,
  });
  assert.equal(r, "navigated");
  assert.equal(gotos, 3);
});

// waitUntil resolves on a lifecycle event, so a slow subresource can blow the
// deadline while the document is already able to issue a same-origin fetch.
test("a timeout that still left a usable page is accepted, not retried", async () => {
  let gotos = 0;
  const r = await openSite({
    goto: async () => {
      gotos++;
      throw new Error("page.goto: Timeout 30000ms exceeded");
    },
    usable: async () => true,
    sleep: noSleep,
  });
  assert.equal(r, "usable");
  assert.equal(gotos, 1, "a usable page should not be navigated again");
});

test("a page that is truly unreachable fails, and says why", async () => {
  let gotos = 0;
  await assert.rejects(
    openSite({
      goto: async () => {
        gotos++;
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
      usable: async () => false,
      sleep: noSleep,
      attempts: 3,
    }),
    /could not open .* after 3 attempts: net::ERR_NAME_NOT_RESOLVED/,
  );
  assert.equal(gotos, 3);
});

test("it backs off between attempts, and not after the last one", async () => {
  const waits: number[] = [];
  await assert.rejects(
    openSite({
      goto: async () => {
        throw new Error("nope");
      },
      usable: async () => false,
      sleep: async (ms) => void waits.push(ms),
      attempts: 3,
      backoffMs: (i) => (i + 1) * 100,
    }),
  );
  assert.deepEqual(waits, [100, 200], "backoff should happen between attempts only");
});

test("a usability check that throws neither stops the retries nor hides the real error", async () => {
  let gotos = 0;
  await assert.rejects(
    openSite({
      goto: async () => {
        gotos++;
        throw new Error("the real problem");
      },
      usable: async () => {
        throw new Error("checking failed too");
      },
      sleep: noSleep,
      attempts: 3,
    }),
    /could not open .* the real problem/,
  );
  assert.equal(gotos, 3, "a failing usability check cut the retries short");
});

test("attempts is floored at one, and said in the singular", async () => {
  let gotos = 0;
  await assert.rejects(
    openSite({
      goto: async () => {
        gotos++;
        throw new Error("nope");
      },
      usable: async () => false,
      sleep: noSleep,
      attempts: 0,
    }),
    /after 1 attempt: nope/,
  );
  assert.equal(gotos, 1);
});

test("navigation knobs fall back to the default for anything that is not a positive number", async () => {
  const { positiveEnv } = await import("../src/browser.js");
  const key = "NITHI_TEST_KNOB";
  const cases: [string | undefined, number][] = [
    [undefined, 7],
    ["", 7],
    ["0", 7],
    ["-5", 7],
    ["abc", 7],
    ["NaN", 7],
    ["Infinity", 7],
    ["12", 12],
    ["1.5", 1.5],
  ];
  for (const [value, expected] of cases) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    assert.equal(positiveEnv(key, 7), expected, `for ${JSON.stringify(value)}`);
  }
  delete process.env[key];
});

// Importing playwright costs about two seconds, and most nithi invocations
// (--help, --list, export, completions, status) never launch a browser. The
// import must therefore stay dynamic, inside start().
test("playwright is not imported until a browser is actually needed", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const compiled = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "browser.js"),
    "utf8",
  );
  assert.doesNotMatch(
    compiled,
    /^\s*import\s[^;]*["']playwright["']/m,
    "browser.js has a static import of playwright; it must be dynamic",
  );
  assert.match(compiled, /await import\(["']playwright["']\)/, "the dynamic import is missing");
});

test("the CLI starts fast enough that it clearly did not load playwright", async () => {
  const { spawnSync } = await import("node:child_process");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0);
  // Loading playwright alone takes roughly two seconds; a generous ceiling that
  // still fails loudly if the static import ever comes back.
  assert.ok(elapsed < 1500, `nithi --version took ${elapsed}ms`);
});
