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

The usage bars normally show the subscription of the provider the session is
using. Every other provider pi holds a credential for is fetched as well and
rendered after it, so a second allowance appears with no configuration:

```
codex 5h━━─58% ↻ 4d7h ▸ mistral Vibe━──45% ↻ 7d10h ▸ copilot Month───1%
```

Detection reads pi's auth store and keeps only providers the fetcher can answer
for; providers whose credentials live outside it (Gemini OAuth files, web
sessions) are not picked up, because probing them would spend a request per
refresh and show an error for an allowance you never asked to watch. A detected
provider whose fetch fails is dropped for the same reason — an automatic guess
should cost nothing when it is wrong. An explicit list below keeps its errors,
so a bar that is missing from a configured provider is never ambiguous.

`PI_OBS_USAGE_PROVIDERS` overrides the default when you want a fixed set
(comma-separated pi provider ids or aliases, e.g. `mistral,grok`), and `none`
turns the extra bars off entirely:

```bash
PI_OBS_USAGE_PROVIDERS=mistral,grok pi   # only these two
PI_OBS_USAGE_PROVIDERS=none pi           # active provider only
```

Each extra provider is fetched on the same refresh as the active one, deduplicated
against it, and labelled with its own name (`mistral Vibe━──45% ↻ 7d`). A provider
whose fetch fails shows the error (`mistral HTTP 401`) instead of a blank segment,
so a bar that is missing is never ambiguous.

## Development

```bash
npm test
npm run typecheck
```

## Privacy

Usage data stays in memory and is not written to disk. Only footer settings are stored under `~/.pi/agent/observability/` (or `$PI_CODING_AGENT_DIR/observability/`). Authenticated requests use fixed HTTPS provider endpoints.

## License

MIT
