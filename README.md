# pi-dynamic-footer

Dynamic, configurable footer for [pi](https://github.com/earendil-works/pi) with live observability. Replaces the default footer with a multi-line display showing context usage, TPS, token/cost tracking, subscription quota bars, git status, and more.

## Features

- **Context gauge** — current / max tokens with color-coded usage bar (green → yellow → red)
- **Live TPS** — tokens-per-second during streaming, plus last-turn average
- **Token tracking** — per-turn ↑input / ↓output counts, total session cost
- **Cache ratio** — cache hit percentage
- **Git status** — branch name, dirty state, added/removed lines
- **Subscription usage bars** — rolling window quotas with reset timers for 8 provider types
- **Fast mode indicator** — shows when priority/fast service tier is active
- **Thinking level** — displays current thinking mode (off/minimal/medium/high/xhigh)
- **Labeled segments** — each data point has a compact label
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

## Configuration

### Footer segments

Use `/obs-settings` to toggle individual segments:

| Segment | Shows |
|---|---|
| `modelThink` | Model ID + thinking level |
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

Set the warning (yellow) and expert (red) thresholds in `/obs-settings`:

```
Warning zone:  70% (default)
Expert zone:   90% (default)
```

### Presets

| Preset | Description |
|---|---|
| `all` | Every segment enabled |
| `minimal` | Model + context percentage only |
| `developer` | Full stack: model, TPS, context, tokens, cost, cache, git, quota |
| `ops` | Runtime, git, cost, quota bars |

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `PI_OBS_SHOW_FULL_PATH` | Show full cwd path instead of basename | off |

## How it works

The extension hooks into pi's event system:

- **`session_start`** — initializes state, fetches quota, sets footer
- **`turn_start` / `message_update` / `turn_end`** — tracks TPS, token counts, cost
- **`model_select`** — refreshes quota display on model switch
- **`session_shutdown`** — persists last 10 session summaries

Token counts come from the assistant message's `usage` object (free with every LLM response). Quota data is fetched from each provider's dedicated API using credentials from `~/.pi/agent/auth.json` or environment variables.

## Security and privacy

- Tokens are read only to request usage data and remain in memory; they are never written to the footer's settings or history files, displayed, or logged.
- Authenticated requests use the provider's fixed HTTPS API endpoint. Redirects are rejected and responses are size-limited.
- The footer stores only the last ten local session summaries (cwd, branch, model, token totals, cost, and runtime) under `~/.pi/agent/observability/`. On POSIX systems, the directory is mode `0700` and its data files are mode `0600`.
- Auth values beginning with `!` are intentionally ignored: this package never executes shell commands from `auth.json`. Supply a resolved credential through the provider's environment variable instead.

## Notes

- Auth tokens are read from `~/.pi/agent/auth.json` (populated by pi's `/login` command)
- Providers without configured auth simply don't show usage bars — no errors
- The footer is set via `ctx.ui.setFooter()` and replaces pi's default footer entirely

## License

MIT
