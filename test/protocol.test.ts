import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseRun, buildMessage, extractAtFiles, MAX_FILE_CHARS, MAX_TOTAL_CHARS } = await import(
  "../src/protocol.js"
);

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
