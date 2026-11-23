# pi-dynamic-footer

A configurable live footer for [pi](https://github.com/earendil-works/pi). It replaces pi’s default footer with context usage, model/thinking level, TPS, token and cost tracking, cache ratio, git status, and subscription quota bars.

## Install

```bash
pi install npm:@juanbenjumea/pi-dynamic-footer
```

## Commands

| Command | Action |
|---|---|
| `/footer` or `/footer menu` | Open the footer action menu |
| `/footer toggle` | Show or hide the footer |
| `/footer path` | Toggle folder name or full path |
| `/footer settings` | Configure segments, presets, and context zones |

The footer is enabled by default and replaces pi’s default footer. It adapts to narrow terminals by dropping lower-priority segments first.

## Quota bars

Quota bars are shown when provider credentials are available. Supported providers:

- Claude / Claude Max
- OpenAI Codex
- OpenCode Go
- ClinePass
- Umans
- GitHub Copilot
- Google Gemini
- Kimi Coding
- Synthetic
- z.ai / GLM
- Cursor
- CommandCode
- Openference

API keys normally come from pi’s `auth.json`; providers also support their documented environment variables. Cursor and CommandCode subscription usage requires a browser session cookie in `quota-sessions.json`, not an API key. OpenCode Go account rotation is provided by [`@juanbenjumea/pi-multi-opencode-go`](https://www.npmjs.com/package/@juanbenjumea/pi-multi-opencode-go).

## Configuration

Use `/footer settings` to configure these segments:

`modelThink`, `provider`, `runtime`, `pwd`, `git`, `contextUsage`, `contextProgress`, `contextPercentage`, `contextNumbers`, `tokens`, `tps`, `cost`, `cache`, `turnCount`, and `usageBars`.

Presets:

- **minimal** — model and essential context information
- **standard** — balanced default layout
- **verbose** — all segments, including TPS and turn count
- **performance** — model, context, TPS, and cost

Context thresholds default to 70% (expert) and 85% (warning). The expert threshold cannot exceed the warning threshold.

Set `PI_OBS_SHOW_FULL_PATH=1` to start with the full home-relative working-directory path enabled.

### Tracking more than the active provider

The usage bar reports the provider of the selected model: that is the meter the
session is spending. Other providers are not fetched or shown unless you ask
for them.

`PI_OBS_USAGE_PROVIDERS=auto` adds every provider pi holds a credential for,
detected from its auth store:

```
codex 5h━━─58% ↻ 4d6h ▸ mistral Month───1% ▸ Vibe━──45% ↻ 7d9h
```

A comma-separated list adds exactly those providers instead (pi provider ids or
aliases, e.g. `mistral,grok`). `none` — or leaving it unset — keeps the footer to
the active provider alone.

Detection cannot see credentials that live outside the auth store (Grok's CLI
login, Gemini OAuth files, web sessions), and a detected provider whose fetch
fails is dropped: an automatic guess should cost nothing when it is wrong. An
explicitly listed provider keeps its error, so a missing bar is never ambiguous.

Each window keeps its own label (`mistral Vibe━──45%`), and a provider whose
fetch fails shows the error (`mistral HTTP 401`) instead of a blank segment. A
window at 0% is left out — an empty bar reads as a rendering fault — unless
every window of that provider is empty.

## Development

```bash
npm test
npm run typecheck
```

## Privacy

Usage data stays in memory and is not written to disk. Only footer settings are stored under `~/.pi/agent/observability/` (or `$PI_CODING_AGENT_DIR/observability/`). Authenticated requests use fixed HTTPS provider endpoints.

## License

MIT
