import { test } from "node:test";
import assert from "node:assert/strict";

const { isDeadTarget, DeltaRouter } = await import("../src/browser.js");

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
