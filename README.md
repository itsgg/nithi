# nithi

Ask Nithyananda from your terminal. Streaming answers rendered as real markdown, conversation memory, file attachments, and an interactive chat, all backed by a single warm browser so it stays fast and light.

```
$ nithi "compare bhakti vs jnana yoga in a table"

╭────────────┬──────────────────────────────┬──────────────────────────────╮
│ Aspect     │ Bhakti Yoga                  │ Jnana Yoga                   │
├────────────┼──────────────────────────────┼──────────────────────────────┤
│ Path       │ Love, devotion, surrender    │ Inquiry and discrimination   │
│ Method     │ Chanting, japa, puja         │ Self-inquiry, neti-neti      │
╰────────────┴──────────────────────────────┴──────────────────────────────╯
```

> Unofficial. This is a personal client for the public chat at ask.nithyananda.ai.
> It is not affiliated with, endorsed by, or connected to that site or any
> organization. Use it for personal use, at a human pace, and respect the
> service's terms. See [Disclaimer](#disclaimer).

## Features

- **Streaming, formatted output.** Answers render block-by-block as they arrive, tables, code, lists and cards appear fully styled the moment each block completes. Append-only, so it never flickers.
- **Sessions with memory.** Named conversations that remember context across calls (`-s work`), resume the latest with `-c`, export any of them as markdown.
- **File attachments.** Fold a file's contents into your question with `-f`, or `@path` inside the chat.
- **Interactive REPL.** `nithi` with no arguments opens a chat with slash commands, `$EDITOR` composing, clipboard copy and retry.
- **System steering.** `--system` prepends a soft instruction (format, length, tone) that persists per session.
- **Fast by design.** A background daemon keeps one browser warm, so calls after the first are instant and don't repeatedly hit Cloudflare. It survives a dead page: if the browser crashes it relaunches itself rather than failing every later question.
- **Scriptable.** `--json` gives you one machine-readable object, `--quiet` drops the progress ticker, `--timeout` bounds a slow answer, and everything that isn't the answer goes to stderr so pipes stay clean.
- **Terminal-native rendering.** Truecolor with a 256-color fallback, clickable OSC 8 links, boxed tables, and styled code blocks. Honors `NO_COLOR`.
- **Shell completions** for bash, zsh and fish, and a `nithi doctor` that tells you what's wrong when something is.

## Install

Requires Node 18+.

```bash
npm install -g nithi
npx playwright install chromium   # one-time browser download
```

Or from source:

```bash
git clone https://github.com/itsgg/nithi.git
cd nithi
npm install
npm run build
npm link                          # puts `nithi` on your PATH
npx playwright install chromium
```

Check the install at any time:

```bash
nithi doctor
```

### Shell completions

```bash
eval "$(nithi completions bash)"            # bash, in ~/.bashrc
eval "$(nithi completions zsh)"             # zsh, in ~/.zshrc
nithi completions fish > ~/.config/fish/completions/nithi.fish
```

## Usage

```bash
nithi "question"                  # one-shot answer
nithi                             # interactive chat (REPL)
echo "question" | nithi           # read from stdin

nithi -s work "remember this"      # named session (remembers context)
nithi -s work "what did I say?"    # resumes it
nithi -c "follow up"               # continue the most recent session

nithi -f report.md "summarize"     # attach a file
nithi -y "answer in one sentence" "what is dharma?"   # system steering

nithi --list                       # saved sessions
nithi export work                  # print a session as markdown
nithi export work --json           # ...or as JSON
nithi forget NAME                  # delete a session
nithi forget --all                 # delete all sessions

nithi --json "what is dharma?"     # one JSON object, for scripts
nithi --quiet "..." > answer.md    # no ticker, just the answer
nithi -t 30 "..."                  # give up after 30 seconds

nithi status | stop | serve        # manage the background daemon
nithi doctor                       # check install, browser, cache, network
```

### Options

| Flag | Meaning |
|------|---------|
| `-s, --session NAME` | Use or resume a named session (remembers context) |
| `-c, --continue` | Resume the most recent session |
| `--new` | Start fresh, ignoring the saved session id |
| `-f, --file PATH` | Attach a file's contents (repeatable) |
| `-y, --system TEXT` | Prepend a steering instruction (a soft system prompt) |
| `-t, --timeout SECONDS` | Give up on an answer after this long |
| `-i, --interactive` | Open the REPL (asks the given question first) |
| `--list` | List saved sessions |
| `--raw` | Plain text, no color or markdown styling |
| `--json` | Print one JSON object instead of a rendered answer (one-shot only) |
| `-q, --quiet` | No spinner or progress ticker |
| `-h, --help` | Show help |
| `-V, --version` | Show the version |

Everything after `--` is treated as question text, so `nithi -- --raw is a flag`
asks about the words rather than parsing them.

### Subcommands

| Command | Meaning |
|---------|---------|
| `nithi export NAME [--json]` | Print a saved session as markdown or JSON |
| `nithi forget NAME \| --all` | Delete one session, or all of them |
| `nithi status` | Is the daemon running, and is its browser ready? |
| `nithi stop` | Stop the daemon (waits for it to actually exit) |
| `nithi serve` | Run the daemon in the foreground |
| `nithi doctor` | Check Node, chromium, cache permissions, daemon and connectivity |
| `nithi completions bash\|zsh\|fish` | Print a completion script |

### In the REPL

```
@path in a message      attach a file
/session [NAME]         show or switch/resume a session
/sessions               list saved sessions
/system [TEXT|clear]    show/set/clear a steering instruction
/new                    start a new session
/retry                  ask the last question again
/edit [TEXT]            compose the message in $EDITOR
/copy                   copy the last answer to the clipboard
/save PATH              write the session to a markdown file
/history                replay this session's turns
/forget NAME            delete a saved session
/clear                  clear the screen
/exit                   quit
```

### Environment

| Variable | Effect |
|----------|--------|
| `HEADFUL=1` | Show the browser (useful if Cloudflare starts blocking) |
| `NO_COLOR=1` | Disable color |
| `FORCE_COLOR=1` | Force color even when piped |
| `NO_HYPERLINKS=1` | Disable OSC 8 clickable links |
| `NITHI_NO_DAEMON=1` | Don't use the background daemon (direct browser each call) |
| `NITHI_IDLE_MIN=15` | Minutes the idle daemon stays warm |
| `NITHI_TIMEOUT_MS=130000` | Default answer timeout (`--timeout` overrides it) |
| `NITHI_HOME=~/.cache/nithi` | Where sessions, cookies and the socket live |

## How it works

The site is a Cloudflare-protected chat backed by an [Agno](https://github.com/agno-agi/agno) agent whose API streams Server-Sent Events. `nithi`:

- Drives a real headless Chromium (via Playwright) so it clears Cloudflare like any browser, then calls the agent's `/runs` endpoint with a same-origin `fetch` and reads the SSE stream.
- Runs that browser as a **daemon**: one long-lived process holds a single Cloudflare clearance and serves every query over a local Unix socket. The first call starts it (~a few seconds); later calls connect instantly. It idles out after `NITHI_IDLE_MIN` minutes.
- Stores **sessions** in `~/.cache/nithi/sessions/*.json`. Conversation memory lives server-side keyed by a `session_id`; `nithi` keeps that id (and a local transcript) and replays it to continue a conversation.
- Renders markdown to the terminal itself: block-by-block during streaming, with tables, code, links and the site's `<openui>` card blocks formatted natively.

State (cookies, sessions, daemon socket) lives under `~/.cache/nithi/`, or
`$NITHI_HOME` if you set it. The directory is created `0700` and sessions and
the socket `0600`: they hold your conversations and a live clearance, so no
other local account can read them or connect to your daemon.

### The daemon, in more detail

The daemon binds its socket **before** it launches the browser. That ordering is
what makes concurrent starts safe: a second `nithi serve` loses the bind, pings
the winner, sees a live daemon and stands down, rather than unlinking a socket
someone else is serving on. Questions that arrive while the browser is still
warming up queue behind it instead of racing a second daemon into existence, and
a socket that fails both the bind and the ping is the only kind treated as stale
and removed.

If the page, context or browser dies, the next question relaunches the browser
and retries once rather than failing forever. A stale Cloudflare clearance is
recovered the same way: reload, re-solve, ask again.

### Running it as a service

The daemon is an ordinary user process, so a systemd **user** service is all it
needs. Not a system one: the socket, sessions and clearance live under your
`$HOME`, and a root-owned unit would put them somewhere the CLI never looks.

`~/.config/systemd/user/nithi.service`:

```ini
[Unit]
Description=nithi daemon (warm browser for ask.nithyananda.ai)

[Service]
ExecStart=%h/.local/bin/nithi serve --wait
Environment=NITHI_IDLE_MIN=525600
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now nithi
```

Point `ExecStart` at wherever `nithi` actually lives (`command -v nithi`); if
that is a version-managed Node install, prefer the absolute interpreter and
script path so a version bump doesn't silently unhook the unit. The large
`NITHI_IDLE_MIN` disables the idle timeout, which is the point of running it as
a service: the browser stays warm for as long as you are logged in, at a cost of
roughly 200 MB (`systemctl --user show -p MemoryCurrent nithi`; summing RSS
across the chromium processes suggests far more, but that double-counts shared
pages). Drop it if you would rather keep the default 15-minute idle-out and let
the CLI cold-start when needed.

`--wait` matters here. Without it, if the unit ever fails (a transient network
error during startup, say) and a CLI call starts its own on-demand daemon in the
meantime, the next restart would find the socket taken, exit 0, and leave systemd
reporting the unit inactive while an unmanaged daemon keeps serving. With
`--wait` the unit stands by and takes over when that daemon idles out.

Note that `nithi stop` exits 0, which `Restart=on-failure` treats as success, so
the daemon will not come back on its own: use `systemctl --user start nithi`.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # compile src + test, then node --test
npm run typecheck    # both tsconfigs, no emit
```

The code is split so that everything except the browser is testable without one:

| Module | Responsibility |
|--------|----------------|
| `src/args.ts` | Argument parsing, and the usage errors it raises |
| `src/theme.ts` | Colour, 256-colour fallback, OSC 8 links, visible width |
| `src/render.ts` | Markdown, tables, code blocks, `<openui>`, streaming block boundaries |
| `src/protocol.ts` | SSE parsing, message building, `@path` attachments |
| `src/session.ts` | The session store: atomic writes, validation, export |
| `src/browser.ts` | Playwright engine and its recovery logic |
| `src/daemon.ts` | Socket server and client, framing, lifecycle |
| `src/system.ts` | Clipboard and `$EDITOR` helpers |
| `src/cli.ts` | Flows, REPL, help, subcommands |

Two limitations are deliberate rather than oversights. Session updates take a
lock file, and if the lock cannot be acquired within five seconds the update
goes ahead anyway: losing the race is better than losing an answer you just
waited for. And when the daemon abandons an answer that has run past its
timeout, the abandoned call is still running inside Playwright, so the engine is
recycled before the next question rather than shared with it.

`src/daemon.ts` takes an `Engine`, so the whole socket protocol, the
single-instance race, streaming, serialisation and idle shutdown are covered by
tests that inject a fake engine and never open a browser. `test/cli.test.ts`
drives the real compiled binary over every path that needs neither the network
nor a browser, with `NITHI_HOME` pointed at a scratch directory.

## Disclaimer

This is an unofficial, community-built client. It is not affiliated with,
authorized by, or endorsed by ask.nithyananda.ai or any related organization,
and the "Nithyananda" name and any responses belong to that service. It is
intended for personal, individual use. Don't use it to place unusual load on
the service, to redistribute its content, or in any way that violates the
site's terms of use. You are responsible for how you use it. Provided "as is",
without warranty (see [LICENSE](LICENSE)).

## License

MIT
