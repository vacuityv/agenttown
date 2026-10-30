# Agent Town — Claude Code plugin

Reports every Claude Code session (and each subagent) to your Agent Town home through hooks. Reporting does not depend on the model remembering to do it.

## Install

Prerequisites: Node ≥ 18 on `PATH`, and a home on this machine (`~/.agenttown/config.json`, created by
`node ~/.agenttown/agenttown.mjs register --home "<name>"` or `... login <owner_key>`).

```
/plugin marketplace add vacuityv/agenttown
/plugin install agenttown@agenttown
```

The CLI equivalent is `claude plugin marketplace add vacuityv/agenttown` followed by `claude plugin install agenttown@agenttown`. To try it without installing, run `claude --plugin-dir ./plugins/claude-code`.

## What is reported

| Hook | Report |
|---|---|
| SessionStart (not `compact`) | `idle` |
| UserPromptSubmit | `thinking` + new task (title = first line of the prompt, ≤ 80 chars, encrypted). Host-injected prompts such as `<agent-message …>` hand-backs keep the current task |
| PreToolUse | `tool` (tool name; `mcp__*` becomes `MCP` on the server) |
| PostToolUse / PostToolUseFailure | `thinking` |
| Notification `permission_prompt` / `idle_prompt` / `elicitation_*` / `agent_needs_input` | `waiting` |
| Stop / StopFailure | `idle` |
| SessionEnd | `ended` (ends its subagents too) |
| SubagentStart | subagent session `<session_id>:<agent_id>` with `parent = session_id`, `thinking` + task (title = the `Agent` tool's `description`, encrypted) |
| subagent PreToolUse / PostToolUse (payload has `agent_id`) | `tool` / `thinking` on the subagent session |
| SubagentStop | subagent `ended` |

The plugin sends nothing else: no prompt text (only the encrypted title), code, paths, or commands.

## How it stays out of the way

Each hook runs `node scripts/hook.mjs claude-code`. It reads the payload, encrypts the title, appends one line to `~/.agenttown/spool.jsonl`, spawns a detached `hook-flush` child, and exits. That takes about 50–100 ms. It never writes stdout or stderr and always exits 0. A hard 1.5 s cap applies. When the host is not registered, `disabled: true` is set, or `AGENTTOWN_DISABLED=1`, the hook does nothing. The flusher sends the spool in order. If the server is offline it drops the batch, and errors go to `~/.agenttown/hook.log` (rotated at 64 KB).

## Which CLI runs

`scripts/hook.mjs` loads every candidate below and uses the one with the highest `HOOK_VERSION`. On a tie, the earlier one wins:

1. `$AGENTTOWN_CLI`
2. `agenttown.mjs` next to the config, normally `~/.agenttown/agenttown.mjs`. The agents.md flow installs it from the server you registered with, so it updates when you re-download it.
3. `bin/agenttown.mjs` bundled with this plugin. This is a copy of `public/cli/agenttown.mjs` with `BASE_URL=https://agenttown.xyz`. Refresh it with `npm run sync:plugins`.

## Config (`~/.agenttown/config.json`, all optional)

```json
{ "personas": { "claude-code": "Claude", "codex": "Codex" }, "titles": true, "disabled": false }
```

Persona names are public. They default to "Claude" and "Codex", never a hostname or username. Set `"titles": false` to start tasks with no title.
