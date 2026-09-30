# pi-extension

Hawiyat's collection of [pi](https://github.com/earendil-works/pi) extensions,
packaged as a single installable pi package:

| Extension | What it adds |
|-----------|--------------|
| [hawiyat-provider](#hawiyat-provider) | `hawiyat` model provider for the LiteLLM gateway at `https://ai.hawiyat.cloud` |
| [pi-stats](#pi-stats) | `/stats` command + `usage_stats` tool for token/cost/usage reporting |
| [web-fetch](#web-fetch) | `web_fetch` tool — readable markdown from HTML pages and PDFs |
| [subagents](#subagents) | Async interactive subagents running in tmux panes (`subagent`, `subagent_message`, `subagents_list`) |

## Install

```bash
pi install git:github.com/Hawiyat-Org/pi-extension
```

Or try it for a single invocation without installing:

```bash
pi -e git:github.com/Hawiyat-Org/pi-extension
```

Pi installs the package's runtime dependencies (`@mozilla/readability`,
`linkedom`, `turndown`, `unpdf`) automatically for git sources. The host
packages (`@earendil-works/*`, `@mariozechner/*`, `typebox`) are provided by pi
and declared as optional peers.

## Extensions

### hawiyat-provider

Registers a `hawiyat` provider backed by the Hawiyat LiteLLM gateway. The
gateway exposes a **per-API-key** model catalog, so the provider fetches
`/v1/models` on refresh and enriches it with `/model_group/info`
(mode, vision, reasoning, cost). The last good catalog is cached in
`~/.pi/agent/hawiyat-models.json` for startup and offline use.

It also normalizes the gateway's non-standard streaming format: content arrives
as raw `data: <token>` records (which may contain literal newlines) rather than
OpenAI JSON chunks. The provider re-encodes raw tokens into
`chat.completion.chunk` deltas so pi can consume the stream.

Configuration — the API key is resolved from environment / pi auth, in order:

1. `HAWIYAT_API_KEY`
2. `~/.pi/agent/auth.json` → `hawiyat.key`
3. `~/.pi/agent/models.json` → `providers.hawiyat.apiKey` (literal value)

No key is stored in this repository.

### pi-stats

Usage reporting across every session under the pi sessions root. Aggregates
tokens (input/output/cache/reasoning), cost, messages, tool calls, models,
projects, and daily activity.

Command:

```text
/stats [today|7d|30d|90d|all]
```

Inside the interactive report: `←/→` switch tabs, `↑/↓` scroll, `d` cycles the
range, `r` rescans, `q` closes. Tabs: Overview, Models, Activity, Projects,
Tools, Sessions.

Tool: `usage_stats` lets the model report usage (`range`, `format: text|json`).

Per-file results are cached in `.cache.json` (keyed by mtime + size, gitignored).
The sessions root is resolved from `PI_CODING_AGENT_SESSION_DIR`, then
`PI_CODING_AGENT_DIR`, then `~/.pi/agent`. See
[`extensions/pi-stats/README.md`](extensions/pi-stats/README.md).

### web-fetch

Registers the `web_fetch` tool. It fetches a URL and extracts readable content
as clean markdown:

- HTML via Readability + Turndown, with a Jina Reader fallback for JS-rendered
  or thin pages;
- PDFs via `unpdf` (up to 100 pages / 20 MB);
- sensible size limits (5 MB HTML, 30 s timeout) and a 500-character minimum
  before falling back.

### subagents

Async interactive subagents, forked from
[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
(MIT). `subagent()` returns immediately; the sub-agent runs in its own tmux pane
and its result is steered back into the main session when it finishes.

Tools:

- `subagent` — spawn an agent in a tmux pane (async)
- `subagent_message` — steer a running agent, or resume a finished one by name
- `subagents_list` — list available agent definitions
- `ask_question` — (sub-agent sessions only) ask the orchestrator and wait

Bundled agents live in [`agents/`](agents/) (`scout`, `researcher`, `worker`).
Project (`.pi/agents/`) and global (`~/.pi/agent/agents/`) definitions override
them. Status display is configured via `config.json` in this package directory
(copy [`config.json.example`](config.json.example); `config.json` is gitignored).

Requires [tmux](https://github.com/tmux/tmux).

## Layout

```text
pi-extension/
├── package.json          # pi package manifest
├── agents/               # bundled subagent definitions
├── config.json.example   # example subagent status config
└── extensions/
    ├── hawiyat-provider/
    ├── pi-stats/
    ├── web-fetch/
    └── subagents/
```

## License

MIT © Hawiyat. The `extensions/subagents` code is MIT © 2026 HazAT and carries
its own [LICENSE](extensions/subagents/LICENSE); see
[Acknowledgements](extensions/subagents/README.md) for the upstream lineage.
