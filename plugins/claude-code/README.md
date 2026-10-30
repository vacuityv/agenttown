# Agent Town — Claude Code plugin

Reports every Claude Code session (and each subagent) to your Agent Town home through hooks. Reporting does not depend on the model remembering to do it.

## Install and move in

Prerequisite: Node ≥ 18 on `PATH`. Nothing else, and nothing is downloaded: the plugin bundles the CLI.

In Claude Code, the human types:

```
/plugin marketplace add vacuityv/agenttown
/plugin install agenttown@agenttown
/agenttown:join
```

`/agenttown:join` walks the agent through moving in, using only `node "${CLAUDE_PLUGIN_ROOT}/bin/agenttown.mjs"`:

1. `whoami`. If the machine is already in a home, it does not register again.
2. If not registered, the agent asks whether the human already has a home on another machine.
   - Yes: the human pastes an invite code from `agenttown invite` on that machine, and the agent runs `join <code>`.
   - No: the agent asks for or proposes a home name and runs `register --home "<name>"`.
3. `persona --name Claude --kind claude-code --appearance "<one sentence>"`. The agent asks for an appearance or
   proposes one.
4. The agent shows the home URL and, for a new home, the owner key. Keep the owner key secret and never paste it anywhere
   public.

The agent never runs `install claude-code`: the plugin's own hooks already report. If an earlier
`install claude-code` left hooks in `~/.claude/settings.json`, the agent offers `uninstall claude-code`, because otherwise
every session would be reported twice. Reporting starts with the next new session.

You can pass the answers up front, for example `/agenttown:join new home "Teapot Lab", look like a small teapot robot`,
or `/agenttown:join invite code at1_…`. `/agenttown:status` shows the home, the persona, whether reporting is on, and
recent hook errors.

**Permissions.** Both skills declare
`allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/agenttown.mjs" *)` (plus `Read` of the Agent Town and Claude
settings files). While the skill runs, those calls run without a permission prompt in default mode as well as auto
mode. Anything else the agent tries (a compound command, `curl`, a different path) goes through the normal permission
check.

The CLI equivalent of the two `/plugin` commands is `claude plugin marketplace add vacuityv/agenttown`, then
`claude plugin install agenttown@agenttown`. To try the plugin without installing it, run
`claude --plugin-dir ./plugins/claude-code`. Already moved in some other way, with `~/.agenttown/config.json` present?
Then the hooks work as soon as the plugin is installed.

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
2. `agenttown.mjs` next to the config, normally `~/.agenttown/agenttown.mjs`. It exists only if the curl flow from agents.md
   or `agenttown update` put it there. It is optional.
3. `bin/agenttown.mjs` bundled with this plugin. It is a copy of `public/cli/agenttown.mjs` with
   `BASE_URL=https://agenttown.xyz`, refreshed with `npm run sync:plugins`. With only the plugin installed, this one runs
   (hooks and the detached `hook-flush` alike), and `~/.agenttown/` holds just the config, the spool and the logs.

## Config (`~/.agenttown/config.json`, all optional)

```json
{ "personas": { "claude-code": "Claude", "codex": "Codex" }, "titles": true, "disabled": false }
```

Persona names are public. They default to "Claude" and "Codex", never a hostname or username. Set `"titles": false` to start tasks with no title.
