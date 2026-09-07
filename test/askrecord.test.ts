import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NO_COLOR = "1";
process.env.NITHI_HOME = mkdtempSync(join(tmpdir(), "nithi-ask-"));

const { askAndRecord } = await import("../src/cli.js");
const { newSession, saveSession, loadSession, exportSessionMarkdown } = await import(
  "../src/session.js"
);
import type { Answer } from "../src/browser.js";

/**
 * Run something with the answer text swallowed.
 *
 * The renderer writes to the real stdout, which would scatter answer text
 * through the reporter's output. Scoped to the call rather than the file: held
 * across the whole file it also swallows the reporter, which then reports
 * nothing.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const real = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = real;
  }
}

/** A transport that streams what it is told to, then answers or fails. */
function transport(script: {
  stream?: string[];
  answer?: Answer;
  fail?: string;
}) {
  return {
    async ask(_m: string, _s?: string, onContent?: (p: string) => void) {
      for (const piece of script.stream ?? []) onContent?.(piece);
      if (script.fail) throw new Error(script.fail);
      return script.answer ?? { content: (script.stream ?? []).join("") };
    },
    async close() {},
  };
}

test("a completed answer is recorded whole, and numbered", async () => {
  const s = newSession("whole");
  saveSession(s);
  const r = await quietly(() =>
    askAndRecord(
      transport({ stream: ["the ", "answer\n\n"], answer: { content: "the answer", sessionId: "sid" } }),
      s,
      "a question",
      [],
    ),
  );
  assert.equal(r.turn, 1);
  const disk = loadSession("whole")!;
  assert.equal(disk.turns.length, 1);
  assert.equal(disk.turns[0].a, "the answer");
  assert.equal(disk.turns[0].partial, undefined);
  assert.equal(disk.sessionId, "sid");
});

// The reader is already looking at half an answer. Dropping it left text on the
// screen that the transcript and an export both denied ever existed.
test("an answer cut short is kept, marked, and recorded", async () => {
  const s = newSession("cut");
  saveSession(s);
  await assert.rejects(
    quietly(() =>
      askAndRecord(
        transport({ stream: ["half an ", "answer\n\n"], fail: "the connection died" }),
        s,
        "a question",
        [],
      ),
    ),
    /cut short: the connection died/,
  );
  const disk = loadSession("cut")!;
  assert.equal(disk.turns.length, 1, "the text the reader saw was not recorded");
  assert.equal(disk.turns[0].a, "half an answer");
  assert.equal(disk.turns[0].partial, true);
});

test("a cut-short turn says so in an export", async () => {
  const s = newSession("cutexport");
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(transport({ stream: ["some text\n\n"], fail: "gone" }), s, "q", [])),
    /cut short/,
  );
  assert.match(exportSessionMarkdown(loadSession("cutexport")!), /cut short/);
});

test("a failure before anything arrived records nothing and keeps its message", async () => {
  const s = newSession("nothing");
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(transport({ fail: "refused at the door" }), s, "q", [])),
    (e: unknown) => {
      assert.equal((e as Error).message, "refused at the door", "the message was rewritten");
      return true;
    },
  );
  assert.equal(loadSession("nothing")!.turns.length, 0);
});

test("whitespace alone does not count as an answer worth keeping", async () => {
  const s = newSession("blank");
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(transport({ stream: ["  \n "], fail: "died" }), s, "q", [])),
    /^Error: died$/,
  );
  assert.equal(loadSession("blank")!.turns.length, 0);
});

test("a one-shot with no session records nothing and still reports the failure", async () => {
  await assert.rejects(
    quietly(() => askAndRecord(transport({ stream: ["partial\n\n"], fail: "died" }), null, "q", [])),
    /cut short: died/,
  );
});

test("a cut-short answer reports the turn it was recorded as", async () => {
  const { CutShortError } = await import("../src/cli.js");
  const s = newSession("cutturn");
  s.turns.push({ q: "earlier", a: "answer", at: 1 });
  saveSession(s);
  await assert.rejects(
    quietly(() => askAndRecord(transport({ stream: ["partial\n\n"], fail: "died" }), s, "q", [])),
    (e: unknown) => {
      assert.ok(e instanceof CutShortError);
      // it is the second turn in the transcript, and says so
      assert.equal((e as InstanceType<typeof CutShortError>).turn, 2);
      return true;
    },
  );
  assert.equal(loadSession("cutturn")!.turns.length, 2);
});

test("a failure with nothing shown carries no turn number", async () => {
  const { CutShortError } = await import("../src/cli.js");
  const s = newSession("noturn");
  saveSession(s);
  await assert.rejects(quietly(() => askAndRecord(transport({ fail: "died" }), s, "q", [])), (e: unknown) => {
    assert.ok(!(e instanceof CutShortError), "nothing was shown, so nothing was cut short");
    return true;
  });
});

// Nothing durable reached the screen, so there is no "answer above" to speak of
// and nothing worth keeping.
test("a failure before any block printed records nothing", async () => {
  const s = newSession("unflushed");
  saveSession(s);
  await assert.rejects(
    quietly(() =>
      askAndRecord(transport({ stream: ["half a sentence, no boundary"], fail: "died" }), s, "q", []),
    ),
    /^Error: died$/,
  );
  assert.equal(loadSession("unflushed")!.turns.length, 0);
});
