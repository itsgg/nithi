import { test } from "node:test";
import assert from "node:assert/strict";

// stdout is not a TTY under the test runner and NO_COLOR is set below, so the
// renderer emits plain text. That keeps these assertions about structure, not
// escape codes; the colour paths are covered separately in theme.test.ts.
process.env.NO_COLOR = "1";

const { render, renderMarkdown, inline, safeCut, wrapPlain, stripAnsi, vlen, maxOf, reconcileTail } =
  await import("../src/render.js");

test("headings render with their text and a rule under h1", () => {
  const out = renderMarkdown("# Title");
  assert.match(out, /Title/);
  assert.match(out, /─/);
});

test("h2 and h3 keep their text and drop the hashes", () => {
  assert.match(renderMarkdown("## Sub"), /Sub/);
  assert.doesNotMatch(renderMarkdown("## Sub"), /#/);
  assert.match(renderMarkdown("### Deep"), /Deep/);
});

test("bullets become bullet glyphs and keep indentation", () => {
  const out = renderMarkdown("- one\n- two");
  assert.match(out, /•\s+one/);
  assert.match(out, /•\s+two/);
  assert.match(renderMarkdown("  - nested"), /^ {2}•/m);
});

test("ordered lists keep their numbers", () => {
  assert.match(renderMarkdown("1. first\n2. second"), /1\.\s+first[\s\S]*2\.\s+second/);
});

test("blockquotes are marked and unwrapped", () => {
  const out = renderMarkdown("> quoted");
  assert.match(out, /▏/);
  assert.match(out, /quoted/);
  assert.doesNotMatch(out, /^>/m);
});

test("horizontal rules render as a line", () => {
  assert.match(renderMarkdown("---"), /^─+$/m);
});

test("inline emphasis markers are consumed", () => {
  assert.equal(inline("**bold**"), "bold");
  assert.equal(inline("*em*"), "em");
  assert.equal(inline("__bold__"), "bold");
  assert.equal(inline("a `code` b"), "a  code  b");
});

test("inline links keep the label and expose the url when unlinked", () => {
  const out = inline("[Anthropic](https://example.com)");
  assert.match(out, /Anthropic/);
  assert.match(out, /example\.com/);
});

test("a bare url survives inline rendering", () => {
  assert.match(inline("see https://example.com/x now"), /https:\/\/example\.com\/x/);
});

test("code fences render every line and the language label", () => {
  const out = renderMarkdown("```js\nconst a = 1;\nconst b = 2;\n```");
  assert.match(out, /js/);
  assert.match(out, /const a = 1;/);
  assert.match(out, /const b = 2;/);
});

test("an unterminated code fence still renders its content", () => {
  assert.match(renderMarkdown("```\nunclosed line\n"), /unclosed line/);
});

test("markdown tables render as a box with every cell", () => {
  const out = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(out, /╭/);
  assert.match(out, /╰/);
  for (const cell of ["A", "B", "1", "2"]) assert.match(out, new RegExp(cell));
});

test("table rows with missing trailing cells are padded, not dropped", () => {
  const out = renderMarkdown("| A | B |\n| --- | --- |\n| only |");
  assert.match(out, /only/);
  // every drawn line is the same visible width
  const widths = new Set(
    out.split("\n").filter((l) => l.includes("│") || l.includes("├")).map((l) => vlen(l)),
  );
  assert.equal(widths.size, 1);
});

test("a table cell longer than the budget wraps instead of overflowing", () => {
  const long = "x".repeat(400);
  const out = renderMarkdown(`| A | B |\n| --- | --- |\n| ${long} | y |`);
  for (const line of out.split("\n")) assert.ok(vlen(line) <= 120, `line too wide: ${vlen(line)}`);
});

// Model output is untrusted and can be enormous. Math.max(...array) throws
// RangeError somewhere past ~125k arguments, which is well inside the size of a
// long answer, so every width computation goes through maxOf instead.
test("maxOf survives an array far larger than the argument limit", () => {
  const huge = Array.from({ length: 500_000 }, (_, i) => i);
  assert.throws(() => Math.max(...huge), RangeError, "premise: spread should still overflow");
  assert.equal(maxOf(huge), 499_999);
});

test("maxOf returns the seed for an empty array", () => {
  assert.equal(maxOf([], 3), 3);
  assert.equal(maxOf([]), 0);
});

test("a very long code block renders every line without throwing", () => {
  const body = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
  const out = renderMarkdown("```\n" + body + "\n```");
  assert.match(out, /line 19999/);
});

test("a long table renders without throwing", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `| ${i} | x |`).join("\n");
  const out = renderMarkdown("| A | B |\n| --- | --- |\n" + rows);
  assert.match(out, /1999/);
});

test("wrapPlain never loops forever on a degenerate width", () => {
  assert.deepEqual(wrapPlain("abcdef", 0), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(wrapPlain("abcdef", -5), ["a", "b", "c", "d", "e", "f"]);
});

test("wrapPlain breaks on words and hard-splits an overlong word", () => {
  assert.deepEqual(wrapPlain("aa bb cc", 5), ["aa bb", "cc"]);
  assert.deepEqual(wrapPlain("abcdefgh", 3), ["abc", "def", "gh"]);
});

test("openui cards render their strings", () => {
  const out = render('<openui title="T">Card("Heading", "Body text here")</openui>');
  assert.match(out, /Heading/);
  assert.match(out, /Body text here/);
});

test("openui stat displays render labels and values", () => {
  const out = render(
    '<openui>StatDisplay({label: "Age", value: "42", unit: "yrs"})</openui>',
  );
  assert.match(out, /Age/);
  assert.match(out, /42/);
  assert.match(out, /yrs/);
});

test("text around an openui block is still rendered as markdown", () => {
  const out = render('before\n\n<openui>Card("C")</openui>\n\n# After');
  assert.match(out, /before/);
  assert.match(out, /C/);
  assert.match(out, /After/);
});

test("stripAnsi and vlen ignore colour and hyperlink escapes", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[39m"), "red");
  assert.equal(vlen("\x1b[1mabc\x1b[22m"), 3);
  assert.equal(vlen("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\"), 4);
});

test("safeCut refuses to cut inside a code fence", () => {
  const buf = "para\n\n```\ncode\n\nmore\n";
  assert.equal(safeCut(buf), "para\n\n".length);
});

test("safeCut releases a block once the fence closes", () => {
  const buf = "```\ncode\n```\ntail";
  assert.equal(safeCut(buf), "```\ncode\n```\n".length);
});

test("safeCut refuses to cut inside an openui block", () => {
  const buf = "intro\n\n<openui>\nCard(\n\n";
  assert.equal(safeCut(buf), "intro\n\n".length);
});

test("safeCut releases a closed single-line openui block", () => {
  const buf = '<openui>Card("x")</openui>\nnext';
  assert.equal(safeCut(buf), '<openui>Card("x")</openui>\n'.length);
});

test("safeCut returns 0 when nothing is complete yet", () => {
  assert.equal(safeCut("half a sentence"), 0);
});

test("safeCut never cuts the trailing partial line", () => {
  const buf = "done\n\npartial";
  assert.equal(buf.slice(safeCut(buf)), "partial");
});

// --- reconciling the streamed answer with the authoritative one -------------

test("nothing more to print when the stream matched the final answer", () => {
  assert.equal(reconcileTail("the whole answer", "the whole answer"), "");
  assert.equal(reconcileTail("  spaced  ", "spaced"), "");
});

test("a truncated stream is topped up with only the missing tail", () => {
  assert.equal(reconcileTail("first half", "first half and the rest"), " and the rest");
});

test("everything is printed when no delta arrived at all", () => {
  assert.equal(reconcileTail("", "the answer"), "the answer");
  assert.equal(reconcileTail("   ", "the answer"), "the answer");
});

test("a divergent final answer is not reprinted on top of the streamed one", () => {
  assert.equal(reconcileTail("what was shown", "something else entirely"), "");
});

test("an empty final answer never adds anything", () => {
  assert.equal(reconcileTail("shown", ""), "");
  assert.equal(reconcileTail("shown", undefined as unknown as string), "");
});
