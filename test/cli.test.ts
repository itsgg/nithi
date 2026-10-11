import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Drive the real compiled entry point the way a user does, over the paths that
// never touch the network or a browser.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const HOME = mkdtempSync(join(tmpdir(), "nithi-cli-"));

function run(args: string[], opts: { input?: string; home?: string } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input: opts.input ?? "",
    env: {
      ...process.env,
      NITHI_HOME: opts.home ?? HOME,
      NO_COLOR: "1",
      NITHI_NO_DAEMON: "1",
    },
  });
}

const seed = (name: string, session: Record<string, unknown>) => {
  mkdirSync(join(HOME, "sessions"), { recursive: true });
  writeFileSync(join(HOME, "sessions", `${name}.json`), JSON.stringify(session));
};

test("--version prints just the version", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("--help explains the modes and exits cleanly", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  for (const bit of ["Usage", "--session", "--json", "completions", "doctor"])
    assert.match(r.stdout, new RegExp(bit.replace(/[-[\]]/g, "\\$&")));
});

test("an unknown flag fails with usage guidance, not a stack trace", () => {
  const r = run(["--nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option: --nope/);
  assert.match(r.stderr, /nithi --help/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
});

test("a flag with a missing value fails before any browser is started", () => {
  const r = run(["-s"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--session needs a value/);
});

test("--list reports an empty store plainly", () => {
  const empty = mkdtempSync(join(tmpdir(), "nithi-empty-"));
  const r = run(["--list"], { home: empty });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No saved sessions/);
});

test("--list shows saved sessions newest first", () => {
  seed("alpha", { name: "alpha", updatedAt: 1000, createdAt: 1, turns: [{ q: "old q", a: "a", at: 1 }] });
  seed("beta", { name: "beta", updatedAt: 9000, createdAt: 1, turns: [{ q: "new q", a: "a", at: 1 }] });
  const r = run(["--list"]);
  assert.ok(r.stdout.indexOf("beta") < r.stdout.indexOf("alpha"));
  assert.match(r.stdout, /new q/);
});

test("export prints a session as markdown", () => {
  seed("expo", {
    name: "expo",
    updatedAt: 5,
    createdAt: 1,
    system: "be terse",
    turns: [{ q: "what is dharma", a: "an answer", at: 5 }],
  });
  const r = run(["export", "expo"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^# expo/m);
  assert.match(r.stdout, /what is dharma/);
  assert.match(r.stdout, /an answer/);
  assert.match(r.stdout, /be terse/);
});

test("export --json prints the raw session object", () => {
  seed("jexp", { name: "jexp", updatedAt: 5, createdAt: 1, turns: [{ q: "q", a: "a", at: 5 }] });
  const r = run(["export", "jexp", "--json"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.name, "jexp");
  assert.equal(parsed.turns.length, 1);
});

test("export of an unknown session is a usage error", () => {
  const r = run(["export", "ghost"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no session "ghost"/);
});

test("export with no name explains itself", () => {
  const r = run(["export"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: nithi export/);
});

test("forget removes a session and says so, twice over", () => {
  seed("doomed", { name: "doomed", updatedAt: 1, createdAt: 1, turns: [] });
  assert.match(run(["forget", "doomed"]).stdout, /Forgot session "doomed"/);
  assert.match(run(["forget", "doomed"]).stdout, /No session "doomed"/);
});

test("status reports no daemon when none is running", () => {
  const empty = mkdtempSync(join(tmpdir(), "nithi-nodaemon-"));
  const r = run(["status"], { home: empty });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /daemon not running/);
});

test("stop is a no-op when no daemon is running", () => {
  const empty = mkdtempSync(join(tmpdir(), "nithi-nostop-"));
  const r = run(["stop"], { home: empty });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no daemon running/);
});

test("completions emit a script for every supported shell", () => {
  for (const [shell, marker] of [
    ["bash", /complete -F _nithi nithi/],
    ["zsh", /compdef _nithi nithi/],
    ["fish", /complete -c nithi/],
  ] as const) {
    const r = run(["completions", shell]);
    assert.equal(r.status, 0, `${shell} exited ${r.status}`);
    assert.match(r.stdout, marker);
  }
});

test("completions rejects an unknown shell", () => {
  const r = run(["completions", "csh"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown shell: csh/);
});

test("doctor reports on the install without needing a daemon", () => {
  const r = run(["doctor"]);
  assert.equal(r.status, 0);
  for (const line of ["node", "chromium", "cache dir", "sessions", "daemon"])
    assert.match(r.stdout, new RegExp(line));
});

test("the built entry point is executable with a node shebang", () => {
  assert.ok(existsSync(CLI));
  const first = spawnSync("head", ["-1", CLI], { encoding: "utf8" }).stdout.trim();
  assert.equal(first, "#!/usr/bin/env node");
});

// --- regressions from review -----------------------------------------------

test("--json is refused in the REPL rather than printing nothing", () => {
  const r = run(["--json", "--interactive", "a question"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--json is for one-shot questions/);
});

test("export rejects a flag it does not understand", () => {
  const r = run(["export", "whatever", "--yaml"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option: --yaml/);
});

test("forget refuses to treat a flag as a session name", () => {
  const r = run(["forget", "--everything"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option: --everything/);
});

test("daemon subcommands accept the general flags", () => {
  const empty = mkdtempSync(join(tmpdir(), "nithi-subflags-"));
  const r = run(["status", "--raw"], { home: empty });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /daemon not running/);
  const bad = run(["status", "--bogus"], { home: empty });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option: --bogus/);
});

// A supervisor (systemd) restarting `nithi serve` must not exit 0 when another
// daemon already owns the socket: the unit would go inactive while an
// unmanaged daemon keeps serving. --wait stands by instead.
test("serve exits when another daemon owns the socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "nithi-serve-"));
  const server = await fakeDaemon(join(home, "daemon.sock"));
  // spawn, not spawnSync: the fake daemon runs on this process's event loop, so
  // blocking here would stop it answering the ping the child is waiting on.
  const child = spawn(process.execPath, [CLI, "serve"], {
    env: { ...process.env, NITHI_HOME: home, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d.toString()));
  try {
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(code, 0);
    assert.match(err, /already running \(pid 424242\)/);
  } finally {
    child.kill("SIGKILL");
    await server.close();
  }
});

test("serve --wait stands by instead of exiting", async () => {
  const home = mkdtempSync(join(tmpdir(), "nithi-serve-wait-"));
  const server = await fakeDaemon(join(home, "daemon.sock"));
  const child = spawn(process.execPath, [CLI, "serve", "--wait"], {
    env: { ...process.env, NITHI_HOME: home, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d.toString()));
  try {
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(child.exitCode, null, `serve --wait exited with ${child.exitCode}`);
    assert.match(err, /standing by/);
  } finally {
    child.kill("SIGKILL");
    await server.close();
  }
});

/** A minimal stand-in for a running daemon: it answers ping and nothing else. */
async function fakeDaemon(sockPath: string) {
  const server = net.createServer((sock) => {
    sock.on("data", () => {
      sock.end(JSON.stringify({ ok: true, pong: true, pid: 424242 }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
  return {
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("--markdown refuses the REPL, --json, and an empty question, with nothing on stdout", () => {
  assert.equal(run(["--markdown", "--json", "q"]).status, 2);
  assert.match(run(["--markdown", "-i", "q"]).stderr, /--markdown is for one-shot questions/);
  const empty = run(["--markdown"], { input: "" });
  assert.equal(empty.status, 2);
  assert.equal(empty.stdout, "");
  assert.match(empty.stderr, /no question/);
});
