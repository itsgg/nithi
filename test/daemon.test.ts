import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "nithi-daemon-"));
process.env.NITHI_HOME = HOME;

const { startDaemon, daemonAsk, daemonRequest, pingDaemon, createLineReader } = await import(
  "../src/daemon.js"
);
import type { Answer, Engine } from "../src/browser.js";

let seq = 0;
const sockFor = (name: string) => join(HOME, `${name}-${seq++}.sock`);
const pidFor = (name: string) => join(HOME, `${name}-${seq}.pid`);

/** A stand-in for the Playwright engine: no browser, fully scripted. */
class FakeEngine implements Engine {
  started = 0;
  closed = 0;
  asks: { message: string; sessionId?: string }[] = [];
  behaviour: (message: string, emit: (s: string) => void) => Promise<Answer> = async (m, emit) => {
    emit(m.toUpperCase());
    return { content: m.toUpperCase(), sessionId: "sid-1" };
  };
  startDelayMs = 0;
  startHangs = false;
  startError?: Error;

  async start() {
    if (this.startHangs) await new Promise(() => {}); // never settles, and holds no timer
    if (this.startDelayMs)
      await new Promise((r) => {
        // unref'd: a pending startup must not hold the test run open
        setTimeout(r, this.startDelayMs).unref?.();
      });
    if (this.startError) throw this.startError;
    this.started++;
  }
  async askStream(message: string, sessionId?: string, onContent: (p: string) => void = () => {}) {
    this.asks.push({ message, sessionId });
    return this.behaviour(message, onContent);
  }
  recovered = 0;
  async recover() {
    this.recovered++;
  }
  async close() {
    this.closed++;
  }
}

// --- framing ---------------------------------------------------------------

test("the line reader drains every message in a single chunk", () => {
  const seen: string[] = [];
  const read = createLineReader((l) => seen.push(l));
  read('{"a":1}\n{"a":2}\n{"a":3}\n');
  assert.deepEqual(seen, ['{"a":1}', '{"a":2}', '{"a":3}']);
});

test("the line reader reassembles a message split across chunks", () => {
  const seen: string[] = [];
  const read = createLineReader((l) => seen.push(l));
  read('{"hel');
  read('lo":true}');
  assert.deepEqual(seen, []);
  read("\n");
  assert.deepEqual(seen, ['{"hello":true}']);
});

test("the line reader refuses to buffer without bound", () => {
  const read = createLineReader(() => {}, 64);
  assert.throws(() => read("x".repeat(100)), /line too long/);
});

// --- lifecycle -------------------------------------------------------------

test("a daemon binds, answers a ping and reports itself ready", async () => {
  const sock = sockFor("ping");
  const engine = new FakeEngine();
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("ping"), handleSignals: false });
  assert.equal(d.outcome, "started");
  await d.ready;
  const pong = await pingDaemon(sock);
  assert.equal(pong?.pong, true);
  assert.equal(pong?.ready, true);
  assert.equal(pong?.pid, process.pid);
  await d.stop();
});

test("the socket is created private to the user", async () => {
  const sock = sockFor("perm");
  const d = await startDaemon({
    engine: new FakeEngine(),
    sockPath: sock,
    pidPath: pidFor("perm"),
    handleSignals: false,
  });
  await d.ready;
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  await d.stop();
});

test("the pid file names the running daemon and is removed on shutdown", async () => {
  const sock = sockFor("pid");
  const pid = join(HOME, "pidfile.pid");
  const d = await startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: pid, handleSignals: false });
  await d.ready;
  assert.equal(readFileSync(pid, "utf8"), String(process.pid));
  await d.stop();
  assert.equal(existsSync(pid), false);
});

test("a second daemon on a live socket stands down instead of stealing it", async () => {
  const sock = sockFor("race");
  const first = new FakeEngine();
  const a = await startDaemon({ engine: first, sockPath: sock, pidPath: pidFor("race"), handleSignals: false });
  await a.ready;

  const second = new FakeEngine();
  const b = await startDaemon({ engine: second, sockPath: sock, pidPath: pidFor("race"), handleSignals: false });
  assert.equal(b.outcome, "already-running");
  assert.equal(second.started, 0, "the loser must not launch a browser");

  // the winner still owns a working socket
  assert.equal((await pingDaemon(sock))?.pong, true);
  await a.stop();
});

test("the loser of the race does not delete the winner's socket", async () => {
  const sock = sockFor("nosteal");
  const a = await startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: pidFor("nosteal"), handleSignals: false });
  await a.ready;
  const b = await startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: pidFor("nosteal"), handleSignals: false });
  await b.stop(); // the stand-down path must be a no-op
  assert.ok(existsSync(sock), "socket was removed by the process that did not own it");
  assert.equal((await pingDaemon(sock))?.pong, true);
  await a.stop();
});

test("a stale socket left by a killed daemon is reclaimed", async () => {
  const sock = sockFor("stale");
  // a socket file with nothing listening behind it
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(sock, r));
  await new Promise<void>((r) => dead.close(() => r()));
  writeFileSync(sock, ""); // leave a plain file in the way, as a crash would
  const d = await startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: pidFor("stale"), handleSignals: false });
  assert.equal(d.outcome, "started");
  await d.ready;
  assert.equal((await pingDaemon(sock))?.pong, true);
  await d.stop();
});

test("shutdown removes the socket and closes the engine", async () => {
  const sock = sockFor("cleanup");
  const engine = new FakeEngine();
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("cleanup"), handleSignals: false });
  await d.ready;
  await d.stop();
  assert.equal(existsSync(sock), false);
  assert.equal(engine.closed, 1);
  await d.closed;
});

test("stop is idempotent", async () => {
  const sock = sockFor("idem");
  const engine = new FakeEngine();
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("idem"), handleSignals: false });
  await d.ready;
  await Promise.all([d.stop(), d.stop(), d.stop()]);
  assert.equal(engine.closed, 1);
});

// --- asking ----------------------------------------------------------------

test("an ask streams deltas and resolves with the full answer", async () => {
  const sock = sockFor("ask");
  const engine = new FakeEngine();
  engine.behaviour = async (m, emit) => {
    for (const piece of ["one ", "two ", "three"]) emit(piece);
    return { content: "one two three", sessionId: "s-9" };
  };
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("ask"), handleSignals: false });
  await d.ready;

  const deltas: string[] = [];
  const r = await daemonAsk({ op: "ask", message: "hi" }, (p) => deltas.push(p), 5000, sock);
  assert.deepEqual(deltas, ["one ", "two ", "three"]);
  assert.equal(r.content, "one two three");
  assert.equal(r.sessionId, "s-9");
  await d.stop();
});

test("a burst of deltas written in one go is not collapsed", async () => {
  const sock = sockFor("burst");
  const engine = new FakeEngine();
  const pieces = Array.from({ length: 500 }, (_, i) => `d${i}`);
  engine.behaviour = async (_m, emit) => {
    for (const p of pieces) emit(p);
    return { content: pieces.join("") };
  };
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("burst"), handleSignals: false });
  await d.ready;
  const got: string[] = [];
  await daemonAsk({ op: "ask", message: "x" }, (p) => got.push(p), 10000, sock);
  assert.deepEqual(got, pieces);
  await d.stop();
});

test("the session id is forwarded to the engine", async () => {
  const sock = sockFor("sid");
  const engine = new FakeEngine();
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("sid"), handleSignals: false });
  await d.ready;
  await daemonAsk({ op: "ask", message: "q", sessionId: "carried" }, () => {}, 5000, sock);
  assert.equal(engine.asks[0].sessionId, "carried");
  await d.stop();
});

test("an engine failure reaches the client as an error, and the daemon survives", async () => {
  const sock = sockFor("err");
  const engine = new FakeEngine();
  let fail = true;
  engine.behaviour = async (m, emit) => {
    if (fail) throw new Error("page exploded");
    emit("recovered");
    return { content: "recovered" };
  };
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("err"), handleSignals: false });
  await d.ready;

  await assert.rejects(daemonAsk({ op: "ask", message: "q" }, () => {}, 5000, sock), /page exploded/);
  fail = false;
  const r = await daemonAsk({ op: "ask", message: "q" }, () => {}, 5000, sock);
  assert.equal(r.content, "recovered");
  await d.stop();
});

test("questions arriving during startup are queued, not dropped", async () => {
  const sock = sockFor("queue");
  const engine = new FakeEngine();
  engine.startDelayMs = 250;
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("queue"), handleSignals: false });
  // deliberately do not await d.ready
  const r = await daemonAsk({ op: "ask", message: "early" }, () => {}, 5000, sock);
  assert.equal(r.content, "EARLY");
  assert.equal(engine.started, 1);
  await d.stop();
});

test("a ping during startup answers immediately and reports not-ready", async () => {
  const sock = sockFor("notready");
  const engine = new FakeEngine();
  engine.startDelayMs = 400;
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("notready"), handleSignals: false });
  const pong = await pingDaemon(sock, 200);
  assert.equal(pong?.pong, true);
  assert.equal(pong?.ready, false);
  await d.ready;
  await d.stop();
});

test("concurrent questions are serialised onto the one warm page", async () => {
  const sock = sockFor("serial");
  const engine = new FakeEngine();
  let concurrent = 0;
  let peak = 0;
  engine.behaviour = async (m) => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 40));
    concurrent--;
    return { content: m };
  };
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("serial"), handleSignals: false });
  await d.ready;
  await Promise.all(
    ["a", "b", "c", "d"].map((m) => daemonAsk({ op: "ask", message: m }, () => {}, 10000, sock)),
  );
  assert.equal(peak, 1, `engine saw ${peak} concurrent questions`);
  assert.equal(engine.asks.length, 4);
  await d.stop();
});

test("an unknown op is rejected without killing the connection handler", async () => {
  const sock = sockFor("unknown");
  const d = await startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: pidFor("unknown"), handleSignals: false });
  await d.ready;
  const r = await daemonRequest({ op: "nonsense" }, 3000, sock);
  assert.equal(r.ok, false);
  assert.match(r.error!, /unknown op/);
  assert.equal((await pingDaemon(sock))?.pong, true);
  await d.stop();
});

test("a malformed request line gets an error, not a crash", async () => {
  const sock = sockFor("garbage");
  const d = await startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: pidFor("garbage"), handleSignals: false });
  await d.ready;
  const reply = await new Promise<string>((resolve, reject) => {
    const c = net.connect(sock);
    let buf = "";
    c.on("connect", () => c.write("this is not json\n"));
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        c.destroy();
        resolve(buf);
      }
    });
    c.on("error", reject);
  });
  assert.match(reply, /bad request/);
  assert.equal((await pingDaemon(sock))?.pong, true);
  await d.stop();
});

test("the client times out rather than hanging on a silent daemon", async () => {
  const sock = sockFor("silent");
  // Hold the accepted sockets so they can be torn down explicitly: a socket
  // with no data listener stays paused and never observes the client's FIN,
  // which would leave server.close() waiting forever.
  const accepted: net.Socket[] = [];
  const server = net.createServer((s) => accepted.push(s));
  await new Promise<void>((r) => server.listen(sock, r));
  await assert.rejects(daemonRequest({ op: "ping" }, 150, sock), /daemon timeout/);
  for (const s of accepted) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

test("connecting to a socket with no daemon fails fast", async () => {
  assert.equal(await pingDaemon(join(HOME, "nothing-here.sock"), 500), null);
});

test("an idle daemon shuts itself down", async () => {
  const sock = sockFor("idle");
  const engine = new FakeEngine();
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("idle"),
    idleMs: 1,
    handleSignals: false,
  });
  await d.ready;
  await d.closed;
  assert.equal(existsSync(sock), false);
  assert.equal(engine.closed, 1);
});

// --- regressions from review -----------------------------------------------

test("multi-byte characters split across chunk boundaries survive framing", () => {
  const seen: string[] = [];
  const read = createLineReader((l) => seen.push(l));
  const payload = JSON.stringify({ d: "ॐ नमः शिवाय 🕉" });
  const bytes = Buffer.from(payload + "\n", "utf8");
  // split at every possible offset, including mid-character
  for (let i = 1; i < bytes.length; i++) {
    const split: string[] = [];
    const r = createLineReader((l) => split.push(l));
    r(bytes.subarray(0, i));
    r(bytes.subarray(i));
    assert.equal(split.length, 1, `no line after splitting at ${i}`);
    assert.deepEqual(JSON.parse(split[0]), JSON.parse(payload), `corrupted at split ${i}`);
  }
  // and unsplit, through the reader this test opened with
  read(bytes);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0]), JSON.parse(payload));
});

test("non-ascii answers round-trip through the socket intact", async () => {
  const sock = sockFor("unicode");
  const text = "ॐ नमः शिवाय 🕉 Nithyanandam";
  const engine = new FakeEngine();
  engine.behaviour = async (_m, emit) => {
    for (const ch of [...text]) emit(ch);
    return { content: text };
  };
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("unicode"), handleSignals: false });
  await d.ready;
  let got = "";
  const r = await daemonAsk({ op: "ask", message: text }, (p) => (got += p), 10000, sock);
  assert.equal(got, text);
  assert.equal(r.content, text);
  assert.equal(engine.asks[0].message, text);
  await d.stop();
});

test("a client that leaves does not have its question asked", async () => {
  const sock = sockFor("abandon");
  const engine = new FakeEngine();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  engine.behaviour = async (m) => {
    await gate;
    return { content: m };
  };
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("abandon"), handleSignals: false });
  await d.ready;

  // first question occupies the engine
  const first = daemonAsk({ op: "ask", message: "first" }, () => {}, 10000, sock);
  await new Promise((r) => setTimeout(r, 50));
  // second question queues behind it, then its client goes away
  const doomed = net.connect(sock);
  await new Promise((r) => doomed.on("connect", r));
  doomed.write(JSON.stringify({ op: "ask", message: "abandoned" }) + "\n");
  await new Promise((r) => setTimeout(r, 50));
  doomed.destroy();
  await new Promise((r) => setTimeout(r, 50));

  release();
  await first;
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(engine.asks.map((a) => a.message), ["first"]);
  await d.stop();
});

test("an abandoned question does not block the ones behind it", async () => {
  const sock = sockFor("unblock");
  const engine = new FakeEngine();
  const d = await startDaemon({ engine, sockPath: sock, pidPath: pidFor("unblock"), handleSignals: false });
  await d.ready;
  const doomed = net.connect(sock);
  await new Promise((r) => doomed.on("connect", r));
  doomed.write(JSON.stringify({ op: "ask", message: "gone" }) + "\n");
  doomed.destroy();
  const r = await daemonAsk({ op: "ask", message: "after" }, () => {}, 5000, sock);
  assert.equal(r.content, "AFTER");
  await d.stop();
});

test("a stalled engine cannot hold the queue forever", async () => {
  const sock = sockFor("stall");
  const engine = new FakeEngine();
  // The first question never settles and keeps emitting after being abandoned,
  // which is what a real in-page fetch does once the ask timeout fires.
  let stalledEmit: ((s: string) => void) | undefined;
  engine.behaviour = (m, emit) => {
    if (m === "hangs") {
      stalledEmit = emit;
      return new Promise(() => {});
    }
    emit(m);
    return Promise.resolve({ content: m });
  };
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("stall"),
    askTimeoutMs: 150,
    handleSignals: false,
  });
  await d.ready;
  await assert.rejects(daemonAsk({ op: "ask", message: "hangs" }, () => {}, 5000, sock), /took too long/);

  // the queue is released and the next question is served
  const got: string[] = [];
  const r = await daemonAsk({ op: "ask", message: "fine" }, (p) => got.push(p), 5000, sock);
  assert.equal(r.content, "fine");

  // the abandoned call is still alive; its output must not reach this client
  stalledEmit?.("leaked from the abandoned question");
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(got, ["fine"], "an abandoned answer leaked into the next one");
  await d.stop();
});

test("an oversized request is reported as an error, not a bare disconnect", async () => {
  const sock = sockFor("oversize");
  const d = await startDaemon({
    engine: new FakeEngine(),
    sockPath: sock,
    pidPath: pidFor("oversize"),
    handleSignals: false,
  });
  await d.ready;
  const huge = "x".repeat(9 * 1024 * 1024);
  await assert.rejects(
    daemonAsk({ op: "ask", message: huge }, () => {}, 10000, sock),
    /line too long/,
  );
  await d.stop();
});

test("withTimeout clears its timer and passes a value through", async () => {
  const { withTimeout } = await import("../src/daemon.js");
  assert.equal(await withTimeout(Promise.resolve("v"), 1000, "nope"), "v");
  await assert.rejects(withTimeout(new Promise(() => {}), 50, "gave up"), /gave up/);
});

test("withTimeout leaves no unhandled rejection when the loser settles late", async () => {
  const { withTimeout } = await import("../src/daemon.js");
  let unhandled: unknown;
  const onUnhandled = (e: unknown) => (unhandled = e);
  process.on("unhandledRejection", onUnhandled);
  try {
    // rejects well after the guard has already given up
    const slow = new Promise((_, rej) => setTimeout(() => rej(new Error("late failure")), 60));
    await assert.rejects(withTimeout(slow, 20, "gave up"), /gave up/);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(unhandled, undefined, `late rejection went unhandled: ${unhandled}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a daemon survives an engine that rejects after the ask timed out", async () => {
  const sock = sockFor("latereject");
  const engine = new FakeEngine();
  engine.behaviour = () =>
    new Promise((_, rej) => setTimeout(() => rej(new Error("late engine failure")), 200));
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("latereject"),
    askTimeoutMs: 50,
    handleSignals: false,
  });
  await d.ready;
  await assert.rejects(daemonAsk({ op: "ask", message: "q" }, () => {}, 5000, sock), /took too long/);
  await new Promise((r) => setTimeout(r, 300));
  engine.behaviour = async (m) => ({ content: m });
  assert.equal((await daemonAsk({ op: "ask", message: "still here" }, () => {}, 5000, sock)).content, "still here");
  await d.stop();
});

// --- pathname ownership -----------------------------------------------------

test("a daemon leaves behind no staging sockets", async () => {
  const sock = sockFor("staging");
  const d = await startDaemon({
    engine: new FakeEngine(),
    sockPath: sock,
    pidPath: pidFor("staging"),
    handleSignals: false,
  });
  await d.ready;
  const strays = readdirSync(HOME).filter((f) => f.startsWith(basename(sock) + "."));
  assert.deepEqual(strays, [], `staging sockets left behind: ${strays.join(", ")}`);
  await d.stop();
});

// net.Server.close() unlinks whatever path it bound, without checking that the
// path still refers to its own socket. Binding a private path and publishing it
// separately is what stops a departing daemon deleting a successor's socket.
test("a departing daemon does not delete the socket a successor published", async () => {
  const sock = sockFor("succession");
  const first = await startDaemon({
    engine: new FakeEngine(),
    sockPath: sock,
    pidPath: join(HOME, "succ-a.pid"),
    handleSignals: false,
  });
  await first.ready;

  // Simulate a successor that claimed the pathname while the first is on its
  // way out: replace the pathname with a different live socket.
  const accepted: net.Socket[] = [];
  const successor = net.createServer((c) => {
    accepted.push(c);
    c.end(JSON.stringify({ ok: true, pong: true, pid: 777 }) + "\n");
  });
  const staged = sock + ".successor";
  await new Promise<void>((r) => successor.listen(staged, r));
  renameSync(staged, sock);

  await first.stop();

  assert.ok(existsSync(sock), "the successor's socket was deleted by the departing daemon");
  const pong = await pingDaemon(sock);
  assert.equal(pong?.pid, 777, "the successor is no longer reachable");
  for (const c of accepted) c.destroy();
  await new Promise<void>((r) => successor.close(() => r()));
});

test("a departing daemon does not delete a pid file that names someone else", async () => {
  const sock = sockFor("pidowner");
  const pid = join(HOME, "contested.pid");
  const d = await startDaemon({
    engine: new FakeEngine(),
    sockPath: sock,
    pidPath: pid,
    handleSignals: false,
  });
  await d.ready;
  writeFileSync(pid, "999999"); // another daemon took over the pid file
  await d.stop();
  assert.ok(existsSync(pid), "someone else's pid file was removed");
  assert.equal(readFileSync(pid, "utf8"), "999999");
});

test("two daemons reclaiming the same stale pathname leave exactly one reachable", async () => {
  const sock = sockFor("contested");
  // leave a stale pathname behind: a socket file with nothing listening
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(sock, r));
  await new Promise<void>((r) => dead.close(() => r()));
  writeFileSync(sock, "");

  const [a, b] = await Promise.all([
    startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: join(HOME, "c-a.pid"), handleSignals: false }),
    startDaemon({ engine: new FakeEngine(), sockPath: sock, pidPath: join(HOME, "c-b.pid"), handleSignals: false }),
  ]);
  await Promise.all([a.ready, b.ready]);

  const pong = await pingDaemon(sock);
  assert.ok(pong, "no daemon is reachable after a contested reclaim");
  assert.ok([a.pid, b.pid].includes(pong!.pid!) || pong!.pid === process.pid);

  // whichever one lost the pathname must not take the winner's socket with it
  await a.stop();
  await b.stop();
});

// An abandoned answer is still running inside the engine, so the next question
// must not be handed the same page. The daemon recycles the engine first.
test("the engine is recycled after an answer is abandoned", async () => {
  const sock = sockFor("recycle");
  const engine = new FakeEngine();
  engine.behaviour = (m) => (m === "hangs" ? new Promise(() => {}) : Promise.resolve({ content: m }));
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("recycle"),
    askTimeoutMs: 80,
    handleSignals: false,
  });
  await d.ready;
  await assert.rejects(daemonAsk({ op: "ask", message: "hangs" }, () => {}, 5000, sock), /too long/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(engine.recovered, 1, "the engine was not recycled after the timeout");
  assert.equal((await daemonAsk({ op: "ask", message: "next" }, () => {}, 5000, sock)).content, "next");
  await d.stop();
});

test("an ordinary engine error does not recycle the engine", async () => {
  const sock = sockFor("norecycle");
  const engine = new FakeEngine();
  engine.behaviour = () => Promise.reject(new Error("request failed: HTTP 500"));
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("norecycle"),
    askTimeoutMs: 5000,
    handleSignals: false,
  });
  await d.ready;
  await assert.rejects(daemonAsk({ op: "ask", message: "q" }, () => {}, 5000, sock), /HTTP 500/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(engine.recovered, 0, "a plain error should not throw away the warm browser");
  await d.stop();
});

test("a daemon survives an engine with no recover() at all", async () => {
  const sock = sockFor("norecoverfn");
  const engine = new FakeEngine();
  (engine as { recover?: unknown }).recover = undefined;
  engine.behaviour = (m) => (m === "hangs" ? new Promise(() => {}) : Promise.resolve({ content: m }));
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("norecoverfn"),
    askTimeoutMs: 80,
    handleSignals: false,
  });
  await d.ready;
  await assert.rejects(daemonAsk({ op: "ask", message: "hangs" }, () => {}, 5000, sock), /too long/);
  assert.equal((await daemonAsk({ op: "ask", message: "next" }, () => {}, 5000, sock)).content, "next");
  await d.stop();
});

// --- the client deadline measures silence, not elapsed time -----------------

test("a slow startup does not eat the answer's deadline", async () => {
  const sock = sockFor("keepalive");
  const engine = new FakeEngine();
  // startup takes more than twice the client's whole deadline
  engine.startDelayMs = 700;
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("keepalive"),
    waitHeartbeatMs: 50,
    handleSignals: false,
  });
  try {
    // The client still gets its answer, because the daemon keeps saying it is
    // alive and the deadline measures silence rather than elapsed time.
    const r = await daemonAsk({ op: "ask", message: "patient" }, () => {}, 300, sock);
    assert.equal(r.content, "PATIENT");
  } finally {
    await d.stop();
  }
});

test("a client still gives up if the daemon never finishes starting", async () => {
  const sock = sockFor("neverready");
  const engine = new FakeEngine();
  // Long enough that no heartbeat can arrive before the client's deadline,
  // short enough not to hold the test run open.
  engine.startDelayMs = 1_500;
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("neverready"),
    waitHeartbeatMs: 10_000, // no reassurance will arrive in time
    handleSignals: false,
  });
  try {
    await assert.rejects(
      daemonAsk({ op: "ask", message: "q" }, () => {}, 200, sock),
      /daemon timeout/,
    );
  } finally {
    await d.stop();
  }
});

test("an answer that streams for longer than the timeout is not cut off", async () => {
  const sock = sockFor("longstream");
  const engine = new FakeEngine();
  engine.behaviour = async (_m, emit) => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 60));
      emit(`chunk${i} `);
    }
    return { content: "done" };
  };
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("longstream"),
    handleSignals: false,
  });
  await d.ready;
  const got: string[] = [];
  // total stream time (~480ms) far exceeds the 200ms deadline, but no single
  // gap does, so it must survive
  const r = await daemonAsk({ op: "ask", message: "q" }, (p) => got.push(p), 200, sock);
  assert.equal(got.length, 8);
  assert.equal(r.content, "done");
  await d.stop();
});

test("a daemon that truly goes silent still times the client out", async () => {
  const sock = sockFor("silence");
  const engine = new FakeEngine();
  engine.behaviour = () => new Promise(() => {}); // never emits, never settles
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("silence"),
    askTimeoutMs: 10_000,
    handleSignals: false,
  });
  await d.ready;
  await assert.rejects(
    daemonAsk({ op: "ask", message: "q" }, () => {}, 250, sock),
    /daemon timeout/,
  );
  await d.stop();
});

test("a browser that hangs while starting does not keep a client waiting forever", async () => {
  const sock = sockFor("neverstarts");
  const engine = new FakeEngine();
  engine.startHangs = true;
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("neverstarts"),
    waitHeartbeatMs: 20, // reassurance arrives constantly...
    readyTimeoutMs: 150, // ...but readiness has a deadline of its own
    handleSignals: false,
  });
  try {
    await assert.rejects(
      daemonAsk({ op: "ask", message: "q" }, () => {}, 5000, sock),
      /never finished starting/,
    );
  } finally {
    await d.stop();
  }
});

test("every question waiting on startup is reassured, not just the first", async () => {
  const sock = sockFor("queuedbeat");
  const engine = new FakeEngine();
  engine.startDelayMs = 800;
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("queuedbeat"),
    waitHeartbeatMs: 40,
    handleSignals: false,
  });
  try {
    // Three questions arrive while the browser is still starting. They queue
    // behind one another, and every one of their deadlines is shorter than the
    // startup, so all three depend on being kept alive.
    const answers = await Promise.all(
      ["one", "two", "three"].map((m) =>
        daemonAsk({ op: "ask", message: m }, () => {}, 300, sock),
      ),
    );
    assert.deepEqual(
      answers.map((a) => a.content),
      ["ONE", "TWO", "THREE"],
    );
  } finally {
    await d.stop();
  }
});

test("the startup heartbeat stops once the client is gone", async () => {
  const sock = sockFor("beatstop");
  const engine = new FakeEngine();
  engine.startDelayMs = 400;
  const d = await startDaemon({
    engine,
    sockPath: sock,
    pidPath: pidFor("beatstop"),
    waitHeartbeatMs: 20,
    handleSignals: false,
  });
  try {
    const doomed = net.connect(sock);
    await new Promise((r) => doomed.on("connect", r));
    doomed.write(JSON.stringify({ op: "ask", message: "abandoned" }) + "\n");
    await new Promise((r) => setTimeout(r, 60));
    doomed.destroy();
    // the daemon must still come up and serve the next question normally
    const r = await daemonAsk({ op: "ask", message: "after" }, () => {}, 3000, sock);
    assert.equal(r.content, "AFTER");
    assert.deepEqual(engine.asks.map((x) => x.message), ["after"]);
  } finally {
    await d.stop();
  }
});
