# Agent Town — Codex CLI

Codex has two ways to run the reporter. **Use hooks**, which give full fidelity. Use `notify` only when hooks are not available. Configure one, not both. With both enabled, every turn is counted as two tasks.

Prerequisites: Node ≥ 18, `~/.agenttown/agenttown.mjs`, and a registered home (`node ~/.agenttown/agenttown.mjs register --home "<name>"` or `... login <owner_key>`).

## Option A — hooks (recommended)

Hooks are on by default in current Codex. They were verified with codex-cli 0.147, and Codex 0.135 also shows `hooks` as stable. Append this to `~/.codex/config.toml`:

```toml
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 5

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 5

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 5

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 5

[[hooks.SubagentStart]]
[[hooks.SubagentStart.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 5

[[hooks.SubagentStop]]
[[hooks.SubagentStop.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 5

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 5

[[hooks.Interrupt]]
[[hooks.Interrupt.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 3

[[hooks.SessionEnd]]
[[hooks.SessionEnd.hooks]]
type = "command"
command = 'node "$HOME/.agenttown/agenttown.mjs" hook codex'
timeout = 3
```

If you already have a `~/.codex/hooks.json`, you can add the same entries there instead, as `{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "...", "timeout": 5}]}], ...}}`.

**Trust:** Codex runs non-managed hooks only after you review them. Open Codex and run `/hooks` to trust them once. For a single non-interactive run you can pass `--dangerously-bypass-hook-trust` instead.

The mapping matches Claude Code:

| Hook | Report |
|---|---|
| SessionStart | `idle` |
| UserPromptSubmit | `thinking` + new task (first line of the prompt, encrypted) |
| PreToolUse | `tool` |
| PostToolUse | `thinking` |
| Stop / Interrupt | `idle` |
| SessionEnd | `ended` |
| SubagentStart / SubagentStop | a child session `<session_id>:<agent_id>`, started and ended |

The default persona is "Codex". To rename it, set `"personas": {"codex": "<name>"}` in `~/.agenttown/config.json`.

## Option B — `notify` (older Codex, coarse)

`notify` runs once per turn, on `agent-turn-complete`, and passes the payload as a JSON **argument**. Codex accepts only one `notify` program, so this replaces any you already have. The command takes no shell, so use an absolute path:

```toml
notify = ["node", "/Users/<you>/.agenttown/agenttown.mjs", "hook", "codex"]
```

Each turn produces two reports, one right after the other: `thinking` with a new task titled from the first line of `input-messages[0]`, then `idle`. Nothing is reported while the turn is running, so there are no tool or waiting states and no subagents. The character never looks busy, and the busy time in stats stays near zero. Use hooks whenever you can.

## Guarantees

The hook never writes stdout, where Codex would treat output as context or JSON, and always exits 0. It returns in about 0.1 s and sends from a detached child. It does nothing when the host is not registered or when `disabled: true` is set. It sends only status, the tool name, and the encrypted title.
