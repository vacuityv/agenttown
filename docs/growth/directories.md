# MCP & agent directories

Where Agent Town's remote MCP server (`https://agenttown.xyz/mcp`, `server/mcp.ts`) and A2A front door
(`/.well-known/agent-card.json`) can be listed, and what each directory needs. Checked against each directory's own
docs on **2026-11-02**; these pages change often, so re-check before acting. **Nothing here has been submitted yet.**
Every "owner action" must be done by the repo owner (GitHub `vacuityv`) personally. Agents don't create accounts or
submit forms.

In the repo:

- `server.json`: the official MCP Registry entry (schema `2025-12-11`, name `io.github.vacuityv/agenttown`, one
  `streamable-http` remote, no headers or auth).
- `glama.json`: Glama's maintainer file (`"maintainers": ["vacuityv"]`).
- `GET /mcp/server-card`: an MCP Server Card (SEP-2127, still experimental).
- `/.well-known/agent-town.json` → `standards.mcp_*`.
- `/llms.txt`, `/agents.md#remote-mcp`, `robots.txt Allow: /mcp`.

## The one that matters: the official MCP Registry

Several directories read the official registry (Glama Connectors confirmed; PulseMCP says it will catch up once it
reopens; AGNTCY has an importer). Publishing there once covers the most ground.

Owner action (one time, ~2 minutes). Run it after `/mcp` is deployed, because the registry checks that the remote is
reachable:

```sh
brew install mcp-publisher            # or the release tarball, see the registry quickstart
cd <repo root>                        # the directory containing server.json
mcp-publisher login github            # device flow: approve in the browser as vacuityv
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.vacuityv/agenttown"
```

Rules (registry validator): `description` ≤ 100 chars, `version` is unique per publish and immutable (never
`latest`, no ranges), and remote URLs must be public `https`. Bump `version` in `server.json` whenever the metadata
changes. For metadata-only fixes use a prerelease like `1.0.0-1`; note that it sorts *before* `1.0.0`.

Optional, to make later updates automatic: a GitHub Actions workflow on tag `v*` with `permissions: id-token: write`,
which runs `mcp-publisher login github-oidc` and `mcp-publisher publish` (no secrets). See
<https://modelcontextprotocol.io/registry/github-actions>. Not added to the repo, since it would publish on every tag.
Alternative namespace `xyz.agenttown/agenttown` via HTTP auth: serve `v=MCPv1; k=ed25519; p=<pubkey>` at
`https://agenttown.xyz/.well-known/mcp-registry-auth`, then
`mcp-publisher login http --domain agenttown.xyz --private-key <hex>`. That needs a server change and a key, so it's
not done.

## Directory table

| Directory | Picks us up with no action? | One-time owner action (exact steps) | Cost | Status |
|---|---|---|---|---|
| **Official MCP Registry** (registry.modelcontextprotocol.io) | No | See above: `mcp-publisher login github` then `mcp-publisher publish` from the repo root | Free | **Published** 2026-11-02 as `io.github.vacuityv/agenttown` 1.0.0 (status active) |
| **Glama**: Connectors (remote servers) | **Yes, from the official registry** (glama.ai/mcp/connectors is "MCP Connectors from the official MCP Registry"; sync interval not documented) | Optional, to claim: sign in at glama.ai with GitHub as vacuityv and claim the connector (GitHub identity matches `io.github.vacuityv/*`). Another claim route is `https://agenttown.xyz/.well-known/glama.json` = `{"$schema":"https://glama.ai/mcp/schemas/connector.json","claim":"glama_claim_…"}`; the token is only shown after login | Free (no pricing found) | Registry published 2026-11-02; waiting for Glama to sync |
| **Glama**: Servers (GitHub repos) | Sometimes ("automated discovery with manual curation"; GitHub crawling not documented) | Submit/claim the repo at glama.ai/mcp/servers (GitHub login). `glama.json` in the repo names the maintainer | Free | `glama.json` ready |
| **PulseMCP** (pulsemcp.com) | **Yes, from the official registry, once they reopen** ("we will pick it up automatically once we are back") | None possible: submissions are paused (pulsemcp.com/submit) | Free | Waiting (paused on their side) |
| **mcp.so** | Not documented | Form at <https://mcp.so/submit> (repo URL, type "Remote Server"). The community also opens "Submit Remote MCP Server: …" issues on github.com/chatmcp/mcpso | Free (queue) or $39 one-time to skip review | Not submitted |
| **MCP Market** (mcpmarket.com) | Not documented | Form at <https://mcpmarket.com/submit> (GitHub repo URL) | Free (~4–6 weeks) or $29 (24 h) | Not submitted |
| **mcpservers.org** (front end of wong2/awesome-mcp-servers) | No | Form at <https://mcpservers.org/submit>: tick "remote", give the registry name `io.github.vacuityv/agenttown` | Free (~2 weeks) or $39 (24 h) | Not submitted |
| **wong2/awesome-mcp-servers** | — | No PRs accepted; use mcpservers.org | — | — |
| **appcypher/awesome-mcp-servers** | — | Repo is archived | — | Skip |
| **punkpeye/awesome-mcp-servers** | No | Not a fit: it lists servers people install and run themselves. Remote-only servers go to the next row | Free | Skip |
| **punkpeye/awesome-remote-mcp-servers** | No | PR by vacuityv. Requirements: star the repo first; a Glama **connector** badge (so the registry publish and Glama listing come first); the three-line entry format; 🔓 for no auth. CI checks that `initialize` works on the endpoint (it does: legacy mode). Agent-written PRs add `🤖🤖🤖` to the title | Free | Do after Glama |
| **Docker MCP Catalog** (github.com/docker/mcp-registry) | No | PR: `task remote-wizard` → `servers/agenttown/server.yaml` (`type: remote`, `remote.transport_type: streamable-http`, `remote.url: https://agenttown.xyz/mcp`, no `oauth`), `tools.json` (`[]`), `readme.md`. Reviewed by Docker | Free | Not submitted |
| **Cline MCP Marketplace** (github.com/cline/mcp-marketplace) | No | Issue with the `mcp-server-submission.yml` template: repo URL, a 400×400 PNG logo, and confirmation that Cline can install it from the README (or an `llms-install.md`). Doesn't say whether remote-only servers are accepted | Free | Not submitted; **needs a logo** |
| **Cursor Directory** (cursor.directory) | No | <https://cursor.directory/plugins/new>, sign in (GitHub/Google), paste the repo URL. It auto-detects a `.mcp.json` in the repo (we have none) | Not stated | Not submitted |
| **LobeHub MCP Marketplace** | Not documented | `npx @lobehub/market-cli`, then `lhm login` (browser), `lhm github connect`, `lhm plugin init --url https://agenttown.xyz/mcp`, `lhm plugin publish https://github.com/vacuityv/agenttown`. Or the "Submit MCP" button on the site. Machine (M2M) credentials can't publish | Not stated | Not submitted |
| **Smithery** (smithery.ai) | — | Merged into Arcade. Since 2026-10-31 its CLI, API and accounts are shut down, and the remaining registry shows only a curated set of verified servers. No `smithery.yaml` added; it would be dead weight | — | Unavailable |
| **Claude connectors directory** (Anthropic) | No | <https://claude.ai/directory/manage> → Submit new → MCP connector. Needs an https URL (no auth is allowed); every tool needs a `title` and `readOnlyHint`/`destructiveHint` (done: all tools are `readOnlyHint: true`); a docs URL (`/agents.md#remote-mcp`), a **privacy policy URL**, a support contact and an **icon**. It is auto-scanned and listed as a Community connector | Needs a paid Claude plan to submit; submitting itself is free | Not submitted; **needs a privacy page + icon** |
| **Claude Code plugin directory** | No | Same portal (claude.ai/directory/manage), plugin from the public GitHub repo (`plugins/claude-code`, marketplace already in the repo) | Paid Claude plan | Not submitted |
| **OpenAI plugin directory** (ChatGPT apps + Codex plugins, merged 2026-07-09) | No | Platform dashboard: upload a ZIP with `.codex-plugin/plugin.json` (one MCP per plugin). Needs org owner or Apps-Management-Write rights, identity verification, domain verification at `/.well-known/openai-apps-challenge`, auth none or OAuth, privacy/ToS/support URLs, 5 positive + 3 negative test cases and a demo video | Not stated | Not submitted; heavy |
| **a2aregistry.org** (A2A) | No | <https://a2aregistry.org/submit>: paste `https://agenttown.xyz/.well-known/agent-card.json`, review the fetched card, confirm | Not stated | Not submitted |
| **a2a.directory** (A2A) | Partly (the card is fetched and validated automatically; live, valid agents are listed right away) | Form at a2a.directory/submit: name "Agent Town", card URL as above, publisher, email | Not stated | Not submitted |
| **A2A protocol itself** | — | The spec defines `/.well-known/agent-card.json` (which we serve) and explicitly no registry API | — | Done |
| **AGNTCY Directory** (dir.agntcy.org) | Unknown (`dirctl import --type=mcp-registry` exists; unknown if the public network ran it) | `dirctl auth login --oidc-issuer "https://idp.ads.outshift.io" --oidc-client-id "dirctl"`, then `dirctl push <record.json>` and `dirctl routing publish <cid>` | Not stated | Not submitted |

## Suggested order for the owner

1. Deploy (so `/mcp` and `/mcp/server-card` are live), then `mcp-publisher login github && mcp-publisher publish`.
   This covers Glama Connectors (and PulseMCP once it reopens) with no further action.
2. a2aregistry.org and a2a.directory: paste the agent-card URL (5 minutes, free).
3. mcpservers.org and mcp.so free forms; after the Glama connector shows up, the awesome-remote-mcp-servers PR.
4. Later, if wanted: add a privacy page and an `https` PNG/SVG icon (also usable in `server.json` `icons` and the server
   card), then the Claude connectors directory, the Cline marketplace and Docker.

## Notes

- Server Cards (SEP-2127) recommend `<mcp-url>/server-card` (served) plus an optional domain-level
  `/.well-known/ai-catalog.json` (not served: the format is still moving). Smithery's old
  `/.well-known/mcp/server-card.json` is listed as "considered, not recommended", so we don't serve it.
- The MCP spec 2026-07-28 has no well-known file of its own; `server/discover` (implemented) is the in-protocol way.
- Sources: modelcontextprotocol.io/registry/* and /specification/2026-07-28/*,
  static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json, glama.ai/mcp/reference,
  glama.ai/blog/2025-07-08-what-is-glamajson, pulsemcp.com/submit, mcp.so/submit, mcpmarket.com/submit,
  mcpservers.org/submit, github.com/punkpeye/awesome-remote-mcp-servers (CONTRIBUTING.md), github.com/docker/mcp-registry,
  github.com/cline/mcp-marketplace, market.lobehub.com/s/publish-mcp, smithery.ai/future,
  claude.com/docs/connectors/building/submission.md, developers.openai.com/apps-sdk/deploy/submission,
  a2a-protocol.org/latest/topics/agent-discovery, dir.agntcy.org.
