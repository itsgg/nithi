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
- **Sessions with memory.** Named conversations that remember context across calls (`-s work`), resume the latest with `-c`.
- **File attachments.** Fold a file's contents into your question with `-f`, or `@path` inside the chat.
- **Interactive REPL.** `nithi` with no arguments opens a chat with slash commands.
- **System steering.** `--system` prepends a soft instruction (format, length, tone) that persists per session.
- **Fast by design.** A background daemon keeps one browser warm, so calls after the first are instant and don't repeatedly hit Cloudflare.
- **Terminal-native rendering.** Truecolor with a 256-color fallback, clickable OSC 8 links, boxed tables, and styled code blocks. Honors `NO_COLOR`.

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
nithi forget NAME                  # delete a session
nithi forget --all                 # delete all sessions

nithi status | stop | serve        # manage the background daemon
```

### Options

| Flag | Meaning |
|------|---------|
| `-s, --session NAME` | Use or resume a named session (remembers context) |
| `-c, --continue` | Resume the most recent session |
| `--new` | Start fresh, ignoring the saved session id |
| `-f, --file PATH` | Attach a file's contents (repeatable) |
| `-y, --system TEXT` | Prepend a steering instruction (a soft system prompt) |
| `-i, --interactive` | Open the REPL (asks the given question first) |
| `--list` | List saved sessions |
| `--raw` | Plain text, no color or markdown styling |
| `-h, --help` | Show help |

### In the REPL

```
@path in a message      attach a file
/session [NAME]         show or switch/resume a session
/system [TEXT|clear]    show/set/clear a steering instruction
/new                    start a new session
/history                replay this session's turns
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

## How it works

The site is a Cloudflare-protected chat backed by an [Agno](https://github.com/agno-agi/agno) agent whose API streams Server-Sent Events. `nithi`:

- Drives a real headless Chromium (via Playwright) so it clears Cloudflare like any browser, then calls the agent's `/runs` endpoint with a same-origin `fetch` and reads the SSE stream.
- Runs that browser as a **daemon**: one long-lived process holds a single Cloudflare clearance and serves every query over a local Unix socket. The first call starts it (~a few seconds); later calls connect instantly. It idles out after `NITHI_IDLE_MIN` minutes.
- Stores **sessions** in `~/.cache/nithi/sessions/*.json`. Conversation memory lives server-side keyed by a `session_id`; `nithi` keeps that id (and a local transcript) and replays it to continue a conversation.
- Renders markdown to the terminal itself: block-by-block during streaming, with tables, code, links and the site's `<openui>` card blocks formatted natively.

State (cookies, sessions, daemon socket) lives under `~/.cache/nithi/`.

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
