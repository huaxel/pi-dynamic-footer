# pi-dynamic-footer

Dynamic, configurable footer for [pi](https://github.com/earendil-works/pi) with live observability. Replaces the default footer with a multi-line display showing context usage, TPS, token/cost tracking, subscription quota bars, git status, and more.

## Features

- **Context gauge** — current / max tokens with color-coded usage bar (green → yellow → red)
- **Live TPS** — tokens-per-second during streaming, plus last-turn average
- **Token tracking** — per-turn ↑input / ↓output counts, total session cost
- **Cache ratio** — cache hit percentage
- **Git status** — branch name, dirty state, added/removed lines
- **Subscription usage bars** — rolling window quotas with reset timers for 10 provider types
- **Fast mode indicator** — shows when priority/fast service tier is active
- **Provider** — shows the serving provider next to session cost (e.g. `commandcode`)
- **Thinking level** — displays current thinking mode (off/minimal/medium/high/xhigh)
- **Labeled segments** — each data point has a compact label
- **Narrow-screen safe** — on small terminals low-priority segments (turn counter, TPS, runtime, path) drop first so the context gauge, model, cost and provider always stay visible
- **Settings UI** — `/obs-settings` command to toggle segments, configure zones, load presets
- **Dashboard** — `/obs` command for full observability dashboard + last 10 sessions
- **Toggle** — `/obs-toggle` to show/hide the footer

## Install

```bash
pi install npm:@juanbenjumea/pi-dynamic-footer
```

## Commands

| Command | Description |
|---|---|
| `/obs` | Full observability dashboard + last 10 session summaries |
| `/obs-toggle` | Show/hide the dynamic footer |
| `/obs-toggle-path` | Toggle between folder name and full cwd path in the footer |
| `/obs-settings` | Open footer settings UI (segment toggles, zones, presets) |

## Supported Providers (quota bars)

| Provider | Auth source | Windows |
|---|---|---|
| Claude / Claude Max | `auth.json` (`anthropic`) or macOS keychain | 5h, Week, Month |
| OpenAI Codex | `auth.json` (`openai-codex`) or `~/.codex/auth.json` | 5h, Week, Month |
| OpenCode Go | `auth.json` (`quota-status.opencode-go` or `opencode-go-failover`) | 5h, Week, Month |
| ClinePass | `auth.json` (`cline-pass`) or `CLINE_API_KEY` env | 5h, Week, Month |
| Umans | `auth.json` (`umans`) or `UMANS_API_KEY` env | Requests, Concurrency |
| GitHub Copilot | `auth.json` (`github-copilot`) | Premium, Chat |
| Google Gemini | `auth.json` (`google-gemini-cli`) or `~/.gemini/oauth_creds.json` | Pro, Flash |
| Kimi Coding | `auth.json` (`kimi-coding`) or `KIMI_API_KEY` env | Windows, Week |
| Cursor | `quota-sessions.json`, `auth.json` (`cursor.cookie`), `CURSOR_COOKIE`, CodexBar manual cookie, or Cursor app `state.vscdb` | Plan, Auto, API |
| CommandCode | `quota-sessions.json`, `auth.json` (`commandcode.cookie`), `COMMANDCODE_COOKIE`, or CodexBar manual cookie | 5h, Week, Month |

### Web session cookies (`quota-sessions.json`)

Subscription quota for Cursor and CommandCode uses **website session cookies**, separate from API keys in `auth.json`:

| File | Purpose | Track in git? |
|---|---|---|
| `~/.pi/agent/auth.json` | API keys / OAuth from `/login` | No |
| `~/.pi/agent/quota-sessions.json` | Browser cookies for quota bars | No |

Copy `pi/agent/quota-sessions.example.json` to `~/dotfiles/pi/agent/quota-sessions.json` (or `~/.pi/agent/` when `PI_CODING_AGENT_DIR` points elsewhere). Paste the **full `Cookie` header** from DevTools — do not guess the cookie name. CommandCode may use `__Secure-commandcode_prod_.session_token` (current production) or legacy `__Secure-better-auth.session_token`; the footer accepts any known session name from the header. Sync via SOPS (`secrets/pi-quota-sessions.json.enc`, same pipeline as `pi-auth.json`).

For **Cursor**, quota data comes from `cursor.com/api/usage-summary`. On Linux, the footer can also derive a session from the signed-in Cursor app's access token. Cursor SDK API keys (`crsr_…`) do not expose subscription windows.

For **CommandCode**, the footer calls `api.commandcode.ai/internal/billing/*`. Pi's `/login` API key is for chat only — put the browser session cookie in `quota-sessions.json`. Legacy `auth.json` `*.cookie` fields and CodexBar manual cookies still work as fallbacks.

For **multi-account OpenCode Go rotation**, install [`@juanbenjumea/pi-multi-opencode-go`](https://www.npmjs.com/package/@juanbenjumea/pi-multi-opencode-go) alongside this footer. OpenCode Go, Cursor, and CommandCode quota fetching lives in [`@juanbenjumea/opencode-go-usage`](https://www.npmjs.com/package/@juanbenjumea/opencode-go-usage) (v0.3.0+): OpenCode Go via the official usage API; Cursor/CommandCode via `quota-sessions.json` web cookies.

## Configuration

### Footer segments

Use `/obs-settings` to toggle individual segments:

| Segment | Shows |
|---|---|
| `modelThink` | Model ID + thinking level |
| `provider` | Serving provider (next to session cost) |
| `runtime` | Session duration |
| `pwd` | Current working directory |
| `git` | Branch, dirty state, ± lines |
| `contextUsage` | Color-coded context usage bar |
| `contextProgress` | Context progress bar |
| `contextPercentage` | Context percentage |
| `contextNumbers` | Verbatim token counts |
| `tokens` | Total ↑input / ↓output tokens |
| `tps` | Live or last-turn tokens/sec |
| `cost` | Total session cost |
| `cache` | Cache hit ratio |
| `turnCount` | Current turn number |
| `usageBars` | Subscription quota usage bars |

### Context zones

Set the expert and warning thresholds in `/obs-settings`. The context
usage bar is **green** at or below the expert zone, **yellow** between the
expert and warning zones, and **red** above the warning zone:

```
Expert zone:   70% (default)  — green/yellow boundary (bar turns yellow above this)
Warning zone:  85% (default)  — yellow/red boundary (bar turns red above this)
```

The expert zone must stay at or below the warning zone; setting one past the
other automatically pulls the other along to preserve the green → yellow →
red ordering.

### Presets

| Preset | Description |
|---|---|
| `minimal` | Model + context usage bar, percentage, and token counts only |
| `standard` | Default — model, runtime, pwd, git, context, tokens, cost, cache, quota bars (no live TPS) |
| `verbose` | Everything, including live TPS and the turn counter |
| `performance` | Focused on speed: model, context, TPS, cost (hides runtime, git, quota bars) |

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `PI_OBS_SHOW_FULL_PATH` | Show full cwd path instead of basename | off |

## How it works

The extension hooks into pi's event system:

- **`session_start`** — initializes state, fetches quota, sets footer
- **`turn_start` / `message_update` / `turn_end`** — tracks TPS, token counts, cost
- **`model_select`** — refreshes quota display on model switch
- **`session_shutdown`** — persists the session summary (keeps the last 200, displays the 10 most recent in `/obs`)

Token counts come from the assistant message's `usage` object (free with every LLM response). Quota data is fetched from each provider's dedicated API using credentials from `~/.pi/agent/auth.json` or environment variables.

## Security and privacy

- Tokens are read only to request usage data and remain in memory; they are never written to the footer's settings or history files, displayed, or logged.
- Authenticated requests use the provider's fixed HTTPS API endpoint. Redirects are rejected and responses are size-limited.
- The footer stores only the last ten local session summaries (cwd, branch, model, token totals, cost, and runtime) under `~/.pi/agent/observability/` (or `<PI_CODING_AGENT_DIR>/observability/` when that variable is set — the same override pi's auth layer honors). On POSIX systems, the directory is mode `0700` and its data files are mode `0600`.
- Auth values beginning with `!` are intentionally ignored: this package never executes shell commands from `auth.json`. Supply a resolved credential through the provider's environment variable instead.

## Notes

- Auth tokens are read from `~/.pi/agent/auth.json` (populated by pi's `/login` command)
- Providers without configured auth simply don't show usage bars — no errors
- The footer is set via `ctx.ui.setFooter()` and replaces pi's default footer entirely

## License

MIT
