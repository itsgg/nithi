import net from "node:net";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Answer, Engine } from "./browser.js";
import { CACHE, DIR_MODE, DPID, FILE_MODE, SOCK } from "./paths.js";

export const DEFAULT_TIMEOUT_MS = Number(process.env.NITHI_TIMEOUT_MS) || 130_000;
const TIMED_OUT = "the answer took too long";

export const IDLE_MS = (Number(process.env.NITHI_IDLE_MIN) || 15) * 60_000;

export interface Reply {
  ok?: boolean;
  content?: string;
  sessionId?: string;
  error?: string;
  pong?: boolean;
  ready?: boolean;
  pid?: number;
  started?: number;
  version?: string;
}

// --- framing ---------------------------------------------------------------

/**
 * Newline-delimited JSON over a stream socket. A TCP read can split one message
 * across chunks or deliver several at once; the old inline parsers looked at
 * `indexOf("\n")` once per chunk and never drained the buffer, so a burst of
 * deltas arriving in a single read dropped all but the first.
 */
export function createLineReader(onLine: (line: string) => void, maxChars = 8 * 1024 * 1024) {
  let buf = "";
  // A chunk boundary can fall in the middle of a multi-byte character, and
  // Buffer#toString on each chunk independently would turn it into replacement
  // characters. Answers here are routinely Sanskrit, so decode statefully.
  const decoder = new StringDecoder("utf8");
  return (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    // buf.length counts UTF-16 code units, not bytes: this is a bound on how
    // much a peer can make us hold, not an exact byte limit.
    if (buf.length > maxChars) {
      buf = "";
      throw new Error("line too long");
    }
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

/**
 * Reject if `p` has not settled within `ms`, without leaving a dangling timer.
 *
 * Promise.race attaches its handlers to `p` immediately, so a rejection that
 * arrives after the guard has already won is still considered handled and does
 * not take the daemon down as an unhandled rejection. The test of that name
 * exists to keep any future rewrite of this function honest.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

const writeLine = (sock: net.Socket, obj: unknown) => {
  if (!sock.destroyed && sock.writable) sock.write(JSON.stringify(obj) + "\n");
};
const endLine = (sock: net.Socket, obj: unknown) => {
  if (!sock.destroyed && sock.writable) sock.end(JSON.stringify(obj) + "\n");
};

// --- client ----------------------------------------------------------------

function connect(sockPath: string) {
  return net.connect(sockPath);
}

export function daemonRequest(
  payload: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sockPath = SOCK,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // destroy, not end: a half-open socket after a timeout keeps the process
      // alive and leaves the daemon writing into nothing.
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("daemon timeout"))), timeoutMs);
    const read = createLineReader((line) => {
      finish(() => {
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => {
      try {
        read(d);
      } catch (e) {
        finish(() => reject(e as Error));
      }
    });
    sock.on("error", (e) => finish(() => reject(e)));
    sock.on("close", () => finish(() => reject(new Error("daemon closed"))));
  });
}

/** Streaming ask: forwards each text delta to onDelta, resolves on completion. */
export function daemonAsk(
  payload: unknown,
  onDelta: (piece: string) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sockPath = SOCK,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    let done = false;
    const end = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => end(() => reject(new Error("daemon timeout"))), timeoutMs);
    const read = createLineReader((line) => {
      let m: { t?: string; d?: string; content?: string; sessionId?: string; error?: string };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.t === "d") onDelta(m.d ?? "");
      else if (m.t === "done") end(() => resolve({ content: m.content ?? "", sessionId: m.sessionId }));
      else if (m.t === "err") end(() => reject(new Error(m.error || "daemon error")));
    });
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => {
      try {
        read(d);
      } catch (e) {
        end(() => reject(e as Error));
      }
    });
    sock.on("error", (e) => end(() => reject(e)));
    sock.on("close", () => end(() => reject(new Error("daemon closed"))));
  });
}

export async function pingDaemon(sockPath = SOCK, timeoutMs = 2000): Promise<Reply | null> {
  try {
    const r = await daemonRequest({ op: "ping" }, timeoutMs, sockPath);
    return r?.pong ? r : null;
  } catch {
    return null;
  }
}

// --- server ----------------------------------------------------------------

export interface DaemonHandle {
  /** "started" when this process owns the socket, "already-running" when another daemon does. */
  outcome: "started" | "already-running";
  pid: number;
  /** Resolves once the engine is up and questions can be answered. */
  ready: Promise<void>;
  /** Resolves when the daemon has shut down (idle timeout, stop, or a signal). */
  closed: Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  engine: Engine;
  sockPath?: string;
  pidPath?: string;
  idleMs?: number;
  /** Give up on a single question after this long (0 disables). */
  askTimeoutMs?: number;
  /** Install SIGINT/SIGTERM handlers (off in tests). */
  handleSignals?: boolean;
  log?: (msg: string) => void;
  version?: string;
}

function listen(server: net.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

/**
 * Bind the socket, then bring the engine up behind it.
 *
 * Binding first is what makes a second `nithi serve` safe: the loser of the
 * race gets EADDRINUSE, pings, sees a live daemon and exits, instead of
 * unlinking the winner's socket out from under it. Only a socket that fails
 * both the bind and the ping is treated as stale and removed, and shutdown only
 * removes files this process actually created.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const sockPath = opts.sockPath ?? SOCK;
  const pidPath = opts.pidPath ?? DPID;
  const idleMs = opts.idleMs ?? IDLE_MS;
  // Slightly beyond the client's own patience, so a normal client timeout is
  // the one the user sees, and this only catches a genuinely stuck engine.
  const askTimeoutMs = opts.askTimeoutMs ?? DEFAULT_TIMEOUT_MS + 30_000;
  const log = opts.log ?? (() => {});

  mkdirSync(CACHE, { recursive: true, mode: DIR_MODE });

  const started = Date.now();
  let lastActivity = Date.now();
  let inFlight = 0;
  let owns = false;

  // The inode behind the pathname we published. At shutdown the pathname is only
  // removed if it still resolves to this inode: after a contested reclaim it may
  // belong to another daemon, and removing it would make that one unreachable.
  let boundIno: number | undefined;

  const server = net.createServer();
  server.on("error", (e) => log(`socket error: ${(e as Error).message}`));

  // Bind to a private pathname and publish it separately, rather than binding
  // the shared pathname directly. net.Server.close() unconditionally unlinks
  // whatever path it bound, with no check that the path still refers to its own
  // socket, so a server that binds the shared path can delete a successor's
  // socket on the way out. Binding a per-process path means close() only ever
  // removes that, and the shared pathname stays under our control.
  const stagePath = `${sockPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  await listen(server, stagePath);

  // Our socket's own inode, read from the staging path before publishing. It
  // survives link() and rename(), so it identifies this socket for the rest of
  // the process's life. Reading it from the shared pathname afterwards would be
  // wrong: two daemons reclaiming a stale pathname can both rename over it, and
  // the loser would sample the winner's inode and later delete a live socket.
  try {
    boundIno = statSync(stagePath).ino;
  } catch {
    // without it we simply never claim the pathname at shutdown
  }

  const abandonStage = async () => {
    await new Promise<void>((res) => server.close(() => res()));
    try {
      unlinkSync(stagePath);
    } catch {
      // close() already removed it
    }
  };

  /**
   * Publish the staged socket at the shared pathname.
   *
   * Returns the daemon that already owns it, if there is a live one. link() is
   * the atomic claim: it fails with EEXIST when the pathname is taken, so only
   * one starting daemon can win an unclaimed socket.
   */
  const publish = async (): Promise<Reply | null> => {
    try {
      linkSync(stagePath, sockPath);
      return null;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Some filesystems refuse a hard link to a socket. Falling back to
        // rename gives up the atomic "only one winner" property, but beats not
        // starting at all, and the inode check at shutdown keeps it
        // non-destructive either way.
        if (existsSync(sockPath)) throw e;
        renameSync(stagePath, sockPath);
        log(`link() unavailable (${code}); published the socket by rename`);
        return null;
      }
      const other = await pingDaemon(sockPath);
      if (other) return other;
      // Nothing answers: the pathname is a leftover from a killed daemon.
      // rename() replaces it atomically. If two daemons reach here at once the
      // last one wins the pathname, and the other finds at shutdown that the
      // inode is no longer its own and leaves it alone.
      renameSync(stagePath, sockPath);
      return null;
    }
  };

  let incumbent: Reply | null;
  try {
    incumbent = await publish();
  } catch (e) {
    await abandonStage();
    throw e;
  }
  if (incumbent) {
    await abandonStage();
    return {
      outcome: "already-running",
      pid: incumbent.pid ?? 0,
      ready: Promise.resolve(),
      closed: Promise.resolve(),
      async stop() {},
    };
  }
  owns = true;

  try {
    unlinkSync(stagePath); // gone already if we got here through rename()
  } catch {
    // expected on the rename path
  }

  // The socket is a capability to ask questions as this user and to read back
  // the answers; other local accounts have no business connecting to it.
  try {
    chmodSync(sockPath, FILE_MODE);
  } catch {
    // best effort; some filesystems refuse chmod on sockets
  }
  try {
    writeFileSync(pidPath, String(process.pid), { mode: FILE_MODE });
  } catch {
    // a missing pidfile is not fatal
  }

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let readyState: "pending" | "ok" | "failed" = "pending";
  ready.catch(() => {});

  let resolveClosed!: () => void;
  const closed = new Promise<void>((res) => (resolveClosed = res));

  // Serialise questions: one warm page, one conversation at a time.
  let queue: Promise<unknown> = Promise.resolve();

  server.on("connection", (sock) => {
    sock.on("error", () => {});
    // A client that times out or is killed destroys its socket. Without noticing
    // that, its question would still be asked (with nobody to receive it) and,
    // worse, would keep its slot in the queue.
    let gone = false;
    sock.on("close", () => {
      gone = true;
    });
    const read = createLineReader((line) => {
      let req: { op?: string; message?: string; sessionId?: string };
      try {
        req = JSON.parse(line);
      } catch {
        return endLine(sock, { ok: false, error: "bad request" });
      }
      lastActivity = Date.now();

      if (req.op === "ping")
        return endLine(sock, {
          ok: true,
          pong: true,
          pid: process.pid,
          started,
          ready: readyState === "ok",
          version: opts.version,
        });

      if (req.op === "stop") {
        endLine(sock, { ok: true });
        void shutdown();
        return;
      }

      if (req.op === "ask" && typeof req.message === "string" && req.message) {
        inFlight++;
        queue = queue.then(async () => {
          let timedOut = false;
          try {
            if (gone) return; // the client left while this was queued
            await ready;
            if (gone) return;
            // A stalled answer must not hold the queue (and inFlight, which
            // gates the idle timer) for the life of the process.
            const r = await withTimeout(
              opts.engine.askStream(req.message!, req.sessionId, (piece) => {
                writeLine(sock, { t: "d", d: piece });
              }),
              askTimeoutMs,
              TIMED_OUT,
            );
            lastActivity = Date.now();
            endLine(sock, { t: "done", content: r.content, sessionId: r.sessionId });
          } catch (e) {
            timedOut = (e as Error).message === TIMED_OUT;
            lastActivity = Date.now();
            endLine(sock, { t: "err", error: (e as Error).message });
            if (timedOut) {
              // The abandoned call is still running somewhere inside the
              // engine. Give the next question a clean engine rather than one
              // shared with a call nobody is waiting for any more.
              await opts.engine.recover?.().catch((err) => {
                log(`recovery after a timed-out answer failed: ${(err as Error).message}`);
              });
            }
          } finally {
            inFlight--;
            lastActivity = Date.now();
          }
        });
        return;
      }

      endLine(sock, { ok: false, error: "unknown op" });
    });
    sock.on("data", (d) => {
      try {
        read(d);
      } catch (e) {
        // Carry both shapes: daemonRequest reads `error`, daemonAsk reads `t`.
        endLine(sock, { ok: false, t: "err", error: (e as Error).message });
        sock.destroy();
      }
    });
  });

  // Bring the engine up behind the already-bound socket. Questions that arrive
  // during startup queue on `ready` rather than racing a second daemon.
  opts.engine
    .start()
    .then(() => {
      readyState = "ok";
      resolveReady();
      log(`nithi daemon listening (pid ${process.pid})`);
    })
    .catch((e) => {
      readyState = "failed";
      rejectReady(e as Error);
      log(`daemon failed to start: ${(e as Error).message}`);
      // A daemon that cannot reach the site is useless; exit so the supervisor
      // (or the next CLI call) can try again with a fresh browser.
      void shutdown(1);
    });

  // Check often enough that a short idleMs is honoured promptly, but never
  // more often than every 30s in the normal (minutes-long) case.
  const tick = Math.min(30_000, Math.max(50, Math.floor(idleMs / 2)));
  const idle = setInterval(() => {
    if (inFlight === 0 && Date.now() - lastActivity > idleMs) void shutdown();
  }, tick);
  idle.unref?.();

  /** Does the socket pathname still resolve to the inode this process bound? */
  function stillOurs(): boolean {
    if (boundIno === undefined) return false;
    try {
      return statSync(sockPath).ino === boundIno;
    } catch {
      return false;
    }
  }

  /** Does the pid file still name this process? */
  function pidFileIsOurs(): boolean {
    try {
      return readFileSync(pidPath, "utf8").trim() === String(process.pid);
    } catch {
      return false;
    }
  }

  let stopping: Promise<void> | undefined;
  function shutdown(exitCode?: number): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(idle);
      await new Promise<void>((res) => server.close(() => res()));
      // Checked after close, not before: a successor may bind while close() is
      // draining existing clients, and only the inode as it stands now says
      // whether the pathname is still ours to remove.
      if (owns && stillOurs()) {
        try {
          unlinkSync(sockPath);
        } catch {
          // already gone
        }
      }
      if (pidFileIsOurs()) {
        try {
          unlinkSync(pidPath);
        } catch {
          // already gone
        }
      }
      await opts.engine.close().catch(() => {});
      resolveClosed();
      if (exitCode !== undefined) process.exit(exitCode);
    })();
    return stopping;
  }

  if (opts.handleSignals !== false) {
    const onSignal = () => void shutdown(0);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return {
    outcome: "started",
    pid: process.pid,
    ready,
    closed,
    stop: () => shutdown(),
  };
}
