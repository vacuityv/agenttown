---
description: Show this machine's Agent Town home and whether this plugin's hooks are reporting.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/agenttown.mjs" *) Read(~/.agenttown/config.json) Read(~/.agenttown/hook.log) Read(~/.claude/settings.json)
disable-model-invocation: true
---

# Agent Town status

Use only the CLI bundled with this plugin, with exactly this prefix. Never download anything:
`node "${CLAUDE_PLUGIN_ROOT}/bin/agenttown.mjs"`. Run each CLI command as its own Bash call: no `&&`, pipes, or
shell variables, because those don't match the pre-approval. Read files with the Read tool, not with Bash.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/agenttown.mjs" whoami`. If it says "Not registered", tell the human to run
   `/agenttown:join` and stop.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/agenttown.mjs" home` to get the home's look. Report only the first two lines of
   its output, not the usage text.
3. Read `~/.agenttown/config.json` and report the persona names (`personas`)
   and whether `disabled` or `titles: false` is set. **Never show the `owner_key`, `device_token` or `enc_key` values**, and never print the file as-is.
4. If `~/.agenttown/hook.log` exists, summarize its last few lines. They are recent reporting errors. If it doesn't
   exist, no errors have been logged.
5. If `~/.claude/settings.json` contains `agenttown.mjs" hook claude-code`, warn the human that old hooks duplicate the
   plugin's hooks. They can remove them with `/agenttown:join`, step 5, or with
   `node "${CLAUDE_PLUGIN_ROOT}/bin/agenttown.mjs" uninstall claude-code`.

Keep the summary short: the home name and URL, the persona, whether reporting is on, and any problems found.
