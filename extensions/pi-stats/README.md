# pi-stats

Usage reporting for [pi](https://github.com/earendil-works/pi). Aggregates every
session under the pi sessions directory (`~/.pi/agent/sessions` by default) and
reports tokens, cost, messages, tool calls, models, projects and daily activity.

## Commands

| Command | Description |
|---------|-------------|
| `/stats` | Interactive report, all time |
| `/stats today` | Today only |
| `/stats 7d` | Last 7 days |
| `/stats 30d` | Last 30 days |
| `/stats 90d` | Last 90 days |
| `/stats all` | Everything |

Inside the report:

| Key | Action |
|-----|--------|
| `←` / `→` (or `h` / `l`, `1`–`6`) | Switch tab |
| `↑` / `↓` (`k` / `j`), `PgUp` / `PgDn` | Scroll |
| `d` / `]` / `[` | Cycle range |
| `r` | Rescan |
| `q` / `Esc` | Close |

Tabs: **Overview**, **Models**, **Activity**, **Projects**, **Tools**, **Sessions**.

## LLM tool

`usage_stats` lets the model report your usage. Parameters:

- `range`: `today`, `7d`, `30d`, `90d`, `all` (default `all`)
- `format`: `text` (default) or `json`

Example prompts: *"how much have I spent this week?"*, *"which models do I use
most?"*, *"show my token usage for the last 30 days"*.

## Notes

- Cost and tokens come from the `usage` recorded on assistant messages, plus
  compaction/branch summaries, `usage` entries, tool-result usage, and subagent
  artifact transcripts.
- Every rollup (sessions, projects, models, tools) is derived from the same
  range-filtered per-day data, so the numbers always agree. Session and project
  cost in a range view is that session/project's cost *within the range*.
- Per-file results are cached in `.cache.json` (keyed by mtime + size). The first
  scan reads every session; later scans only re-read changed files. Cache writes
  are debounced and non-blocking.
- Sessions root is resolved from `PI_CODING_AGENT_SESSION_DIR`, then
  `PI_CODING_AGENT_DIR`, then `~/.pi/agent`.
