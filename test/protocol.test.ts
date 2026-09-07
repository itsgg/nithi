import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseRun, buildMessage, extractAtFiles, MAX_FILE_CHARS, MAX_TOTAL_CHARS, NoAnswerError } =
  await import("../src/protocol.js");

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n");

test("parseRun prefers the completed content over concatenated deltas", () => {
  const raw = sse([
    { event: "RunContent", content: "par" },
    { event: "RunContent", content: "tial" },
    { event: "RunCompleted", content: "the full answer", session_id: "abc" },
  ]);
  assert.deepEqual(parseRun(raw), { content: "the full answer", sessionId: "abc" });
});

test("parseRun falls back to deltas when no RunCompleted arrives", () => {
  const raw = sse([
    { event: "RunContent", content: "one " },
    { event: "RunContent", content: "two" },
  ]);
  assert.equal(parseRun(raw).content, "one two");
});

test("parseRun picks up a session id from any event", () => {
  const raw = sse([{ event: "RunStarted", session_id: "s-1" }, { event: "RunContent", content: "x" }]);
  assert.equal(parseRun(raw).sessionId, "s-1");
});

test("parseRun ignores [DONE], blank payloads and unparseable lines", () => {
  const raw = ["data: [DONE]", "data:", "data: {not json", ": comment", ""].join("\n");
  assert.equal(parseRun(raw).content, raw.trim());
});

test("parseRun tolerates a stream with no data lines by returning the raw body", () => {
  assert.equal(parseRun("upstream exploded").content, "upstream exploded");
});

test("parseRun ignores non-string content", () => {
  const raw = sse([{ event: "RunCompleted", content: { nested: true } }, { event: "RunContent", content: "ok" }]);
  assert.equal(parseRun(raw).content, "ok");
});

test("buildMessage passes a bare question straight through", () => {
  assert.equal(buildMessage("hello", []), "hello");
});

test("buildMessage puts the system preamble first", () => {
  const out = buildMessage("q", [], "be terse");
  assert.ok(out.startsWith("be terse"));
  assert.ok(out.endsWith("q"));
});

test("buildMessage ignores a blank system preamble", () => {
  assert.equal(buildMessage("q", [], "   "), "q");
});

test("buildMessage fences attachments and names them", () => {
  const dir = mkdtempSync(join(tmpdir(), "nithi-"));
  const f = join(dir, "notes.txt");
  writeFileSync(f, "file body");
  const out = buildMessage("q", [f]);
  assert.match(out, /File: notes\.txt/);
  assert.match(out, /```\nfile body\n```/);
  assert.ok(out.endsWith("q"));
});

test("buildMessage truncates a single oversized attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "nithi-"));
  const f = join(dir, "big.txt");
  writeFileSync(f, "z".repeat(MAX_FILE_CHARS + 5000));
  const out = buildMessage("q", [f]);
  assert.match(out, /truncated/);
  assert.ok(out.length < MAX_FILE_CHARS + 5000);
});

test("buildMessage caps the combined size of many attachments", () => {
  const dir = mkdtempSync(join(tmpdir(), "nithi-"));
  const files = Array.from({ length: 12 }, (_, i) => {
    const f = join(dir, `f${i}.txt`);
    writeFileSync(f, "y".repeat(MAX_FILE_CHARS));
    return f;
  });
  const out = buildMessage("q", files);
  assert.ok(out.length <= MAX_TOTAL_CHARS + 2000, `message was ${out.length} chars`);
});

test("buildMessage reports the path of an unreadable attachment", () => {
  assert.throws(() => buildMessage("q", ["/no/such/file"]), /cannot read file: \/no\/such\/file/);
});

test("extractAtFiles pulls out @paths that exist and leaves the rest alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "nithi-"));
  const f = join(dir, "real.txt");
  writeFileSync(f, "x");
  const { text, files } = extractAtFiles(`look at @${f} please`);
  assert.deepEqual(files, [f]);
  assert.equal(text, "look at please");
});

test("extractAtFiles leaves a non-existent @token in the text", () => {
  const { text, files } = extractAtFiles("email me @someone about it");
  assert.deepEqual(files, []);
  assert.equal(text, "email me @someone about it");
});

test("extractAtFiles expands a leading tilde", () => {
  const { files } = extractAtFiles("@~/definitely-not-here-xyz");
  assert.deepEqual(files, []);
});

// --- a stream that carries no answer ----------------------------------------
// Seen in the wild: a run that emitted only lifecycle events. parseRun used to
// fall back to returning the raw body, so nithi printed the entire SSE
// transcript, hundreds of lines of JSON, as if it were the reply.

const lifecycle = [
  "event: RunStarted",
  `data: {"created_at":1788739610,"event":"RunStarted","agent_id":"ngpt-v4","session_id":"6ab2b91e"}`,
  "",
  "event: PreHookStarted",
  `data: {"created_at":1788739610,"event":"PreHookStarted","session_id":"6ab2b91e"}`,
  "",
  "event: PreHookCompleted",
  `data: {"created_at":1788739610,"event":"PreHookCompleted","session_id":"6ab2b91e"}`,
].join("\n");

/**
 * Run parseRun expecting it to refuse, and hand back the message.
 *
 * Not a try/catch with assert.fail inside it: assert.fail throws, its own catch
 * swallows it, and its message then satisfies whatever the test went on to
 * assert about the message. Every check here happens outside the catch.
 */
function noAnswer(raw: string): string {
  let thrown: unknown;
  let returned: unknown;
  try {
    returned = parseRun(raw);
  } catch (e) {
    thrown = e;
  }
  assert.ok(
    thrown instanceof NoAnswerError,
    `expected NoAnswerError, got ${thrown ? String(thrown) : JSON.stringify(returned)}`,
  );
  return (thrown as Error).message;
}

test("a stream with only lifecycle events is an error, not an answer", () => {
  assert.throws(() => parseRun(lifecycle), NoAnswerError);
});

test("the error names the events that did arrive, and never quotes the stream", () => {
    const m = noAnswer(lifecycle);
    assert.match(m, /RunStarted/);
    assert.doesNotMatch(m, /created_at/, "the raw stream leaked into the message");
    assert.ok(m.length < 200, `message is ${m.length} chars, it should be a line`);
});

test("an error reported inside the stream is what gets surfaced", () => {
  const raw = [
    `data: {"event":"RunStarted","session_id":"s"}`,
    `data: {"event":"RunError","error":"rate limit exceeded"}`,
  ].join("\n");
  assert.throws(() => parseRun(raw), /rate limit exceeded/);
});

test("an error field with no error-shaped event name is still surfaced", () => {
  const raw = `data: {"event":"Something","error":"upstream refused"}`;
  assert.throws(() => parseRun(raw), /upstream refused/);
});

test("a body that is not an event stream is still passed through as-is", () => {
  assert.equal(parseRun("upstream exploded").content, "upstream exploded");
  assert.equal(parseRun("").content, "");
});

test("one lifecycle event alongside real content is not an error", () => {
  const raw = [
    `data: {"event":"RunStarted","session_id":"s"}`,
    `data: {"event":"RunContent","content":"the answer"}`,
  ].join("\n");
  assert.deepEqual(parseRun(raw), { content: "the answer", sessionId: "s" });
});

test("an answer that is only whitespace counts as no answer", () => {
  const raw = [
    `data: {"event":"RunStarted","session_id":"s"}`,
    `data: {"event":"RunCompleted","content":"   "}`,
  ].join("\n");
  assert.throws(() => parseRun(raw), NoAnswerError);
});

// Whatever the service puts in an error field is printed in the user's
// terminal, so it is treated as untrusted text rather than as a message.

test("an error is flattened to a single line with no control characters", () => {
  const esc = String.fromCharCode(27);
  const raw =
    "data: " +
    JSON.stringify({
      event: "RunError",
      error: "line one" + String.fromCharCode(10) + "line two" + String.fromCharCode(9) + "tab" + esc + "[31m",
    });
    const m = noAnswer(raw);
    assert.doesNotMatch(m, /[\n\r]/, "a newline reached the terminal");
    assert.ok(!m.includes(esc), "an escape sequence reached the terminal");
    assert.equal(m, "line one line two tab [31m");
});

test("an oversized error is capped", () => {
  const raw = "data: " + JSON.stringify({ event: "RunError", error: "x".repeat(5000) });
    const m = noAnswer(raw);
    assert.ok(m.length <= 200, `message was ${m.length} chars`);
});

test("an absurd event name cannot inflate the message", () => {
  const raw = "data: " + JSON.stringify({ event: "E".repeat(5000) });
    const m = noAnswer(raw);
    assert.ok(m.length <= 200, `message was ${m.length} chars`);
});

// `content` on an unrecognised event could be anything, so it is never quoted.
test("content on an unknown event is never copied into the error", () => {
  const raw = "data: " + JSON.stringify({ event: "SomethingElse", content: "SECRET-TOKEN-abc123" });
    const m = noAnswer(raw);
    assert.doesNotMatch(m, /SECRET-TOKEN/);
});

// The name can live on the SSE `event:` line, which is not JSON and never
// reaches the parser, so a stream can carry an error with no event name at all.
test("an error with its name only on the SSE line does not fall back to the raw body", () => {
  const raw = ["event: RunError", `data: {"error":"upstream refused","session_id":"s-secret"}`].join("\n");
    const m = noAnswer(raw);
    assert.equal(m, "upstream refused");
    assert.doesNotMatch(m, /s-secret/, "the session id was printed");
});

// A whitespace-only RunCompleted is truthy and used to mask deltas the user had
// already watched arrive, turning a delivered answer into an error.
test("a blank RunCompleted does not discard the deltas already shown", () => {
  const raw = [
    `data: {"event":"RunContent","content":"Visible answer"}`,
    `data: {"event":"RunCompleted","content":"   "}`,
  ].join("\n");
  assert.equal(parseRun(raw).content, "Visible answer");
});

// Invisible characters that reorder or hide what follows them: an error message
// is printed straight into a terminal, so it must not be able to rearrange it.
test("bidi overrides and zero-width characters are removed from an error", () => {
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);
  const ls = String.fromCharCode(0x2028);
  const message = (e: string) => {
    try {
      parseRun("data: " + JSON.stringify({ event: "RunError", error: e }));
      return "(no throw)";
    } catch (x) {
      return (x as Error).message;
    }
  };
  assert.equal(message("safe" + rlo + "text"), "safetext");
  assert.equal(message("a" + zwsp + "b"), "ab");
  assert.equal(message("one" + ls + "two"), "one two");
});

test("capping an error never splits a character in half", () => {
  const raw = "data: " + JSON.stringify({ event: "RunError", error: "\u{1F600}".repeat(300) });
    const m = noAnswer(raw);
    assert.ok([...m].length <= 200);
    const withoutPairs = m.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
    assert.doesNotMatch(withoutPairs, /[\uD800-\uDFFF]/, "a half character survived the cap");
});

// A cut that falls between a letter and its accent produces a different letter.
test("capping never separates a character from its accent", () => {
  const accented = "e" + String.fromCharCode(0x0301); // e + combining acute
  const raw = "data: " + JSON.stringify({ event: "RunError", error: accented.repeat(300) });
  // Asserted exactly. Truncating by code point instead would end with a bare
  // "e", its accent left on the other side of the cut, and a test that only
  // looked for a stranded accent would happily accept that.
  assert.equal(noAnswer(raw), accented.repeat(199) + "…");
});
