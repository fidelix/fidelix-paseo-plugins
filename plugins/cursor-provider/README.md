# Cursor provider plugin

Community Paseo provider that runs the Cursor coding agent through the official
`@cursor/sdk` (local runtime, JSONL store) instead of the `cursor-agent` ACP binary.
It registers provider id `cursor-sdk` ("Cursor SDK", `server/provider.ts:203`).

## Requirements

- Paseo `>=0.10.3` (see `requirements` in `paseo-plugin.json`; matches the installed
  `@getpaseo/plugin` / `@getpaseo/protocol` 0.10.3 SDK).
- Node `>=22.13` on the daemon host (the `@cursor/sdk@1.0.36` `engines` floor).
- No build step: Paseo compiles the TypeScript entries on load, and Git installs run
  no package manager or install scripts, so no `prepare`/`prepack` entry is needed
  (see "Ship notes" below).

## Setup

### 1. Install

```bash
npm run typecheck
paseo plugin install /absolute/path/to/cursor-provider-plugin
paseo plugin ls   # expect `running`
```

Directory installs need `npm install` run manually so `node_modules/@cursor/sdk`
exists for the runtime loader (`server/cursor-sdk-loader.js`).

### 2. API key

The SDK needs a user or service-account API key. **CLI login does not transfer.**
Mint one at [cursor.com/dashboard/api](https://cursor.com/dashboard/api) — usage bills
to your plan like IDE usage.

Key sources, in precedence order (`server/provider.ts:276`):

| Priority | Source | How |
| --- | --- | --- |
| 1 | Per-agent env | `CURSOR_API_KEY` in the agent's env (e.g. `--env`) — wins for that session |
| 2 | Settings UI | Cursor settings screen (host-scoped plugin settings) |
| 3 | Daemon env | `CURSOR_API_KEY` exported on the daemon process |

The settings screen has a **Check key** action that calls the `cursor.validate-key`
RPC: a key-only `Cursor.models.list` catalog check that spends nothing. Otherwise the
key is validated on next session open. Without any key, sessions fail with
`Set CURSOR_API_KEY to use the Cursor provider` and the model catalog falls back to
a single `composer-2.5` entry.

### 3. Local state

Sessions persist in a JSONL store under `~/.cursor/sdk/paseo-plugin`.
Override the root with `CURSOR_SDK_STATE_ROOT` (per-agent env or daemon env).

## What works

- Text and image prompts (`prompt.message`, `prompt.image`).
- Mid-turn steering (`prompt.steer`, via `run.steer`).
- Slash commands (`prompt.command`): `/plan`, `/compact`, `/review`, `/commit`.
- `agent` / `plan` modes, switchable mid-session; model switch applies on next prompt.
- Live model catalog via `Cursor.models.list` (single `composer-2.5` fallback when
  keyless or the list call fails).
- Per-model reasoning effort: the thinking dropdown lists the model's effort
  values (`low`/`medium`/`high`/`xhigh`/`max`, `reasoning` variants, or `On`/`Off`
  for older `thinking` models), defaulting to the model's default variant.
- Fast select (`Off`/`Fast`) on models that expose a `fast` parameter; hidden
  otherwise. Unset follows the model's default variant.
- MCP servers (stdio + http/sse) passed through to the SDK.
- Session persistence / listing / configure; usage reporting
  (input, cached-input, output tokens).
- `task`-tool subagents surfaced as provider-owned child sessions
  (`restoration: "parent"`) with log rows.
- Transient-failure retry: rate-limit / quota (`resource_exhausted`, 429 family) and
  network (5xx / timeout / unavailable) errors retry up to 3 total attempts with
  1s → 15s capped exponential backoff and a visible warning notice per retry
  (`server/retry.ts:103`). Auth/config errors (401/400/404), `agent_busy` (409),
  and cancellations never retry.
- Conversation revert (`session.revert.conversation`) and archive/unarchive — with
  the limits below.

## Limitations

- **Revert is conversation-only.** `files` / `both` scopes throw
  (`Cursor provider supports conversation revert only`). The SDK store is
  append-only with no rewind API, so conversation revert closes the live runtime,
  starts a fresh native agent, and the daemon replays the surviving prefix from its
  own timeline.
- **Archive/unarchive are local-runtime operations.** Archive closes the live
  runtime and drops provider-owned children; the durable JSONL record stays
  resumable via `Agent.resume`. Unarchive is a no-op validation. The SDK's
  **cloud-only `Agent.archive` / `Agent.unarchive` / `Agent.delete` statics are
  unused** — nothing is ever deleted server-side by this provider.
- **Node `>=22.13`** is required by `@cursor/sdk`, even though the daemon compiles
  the server bundle for an older Node target.
- **Static 4-command ceiling.** The SDK exposes no command listing, so only
  `/plan`, `/compact`, `/review`, `/commit` exist (`server/provider.ts:1081`).
  Custom Cursor skills / space commands are not surfaced.
- **Local runs auto-approve tools.** The SDK headless runtime executes tool calls
  without interactive approval. `session.permission` `deny` only cancels the active
  run; `question`-type input requests are surfaced as a `cursor-input` prompt.
- **Reasoning effort is a value dropdown, fast is a select.** Thinking options
  are the model's effort-param *values* (e.g. `low`…`max`), never parameter
  ids (`effort`, `context`) or other models' values — switching models re-keys
  to the new model's default. `context` (window size) always follows the
  default variant; `fast` is a separate `Off`/`Fast` select shown only on
  models that expose it, and unset follows the default variant.
- History replay on resume is best-effort (last ~20 messages) and never blocks
  session open.

## Parity vs the built-in `cursor` provider

The built-in provider shells out to `cursor-agent acp`
(`cursor-agent`, ACP transport); this plugin drives `@cursor/sdk` in-process.

| Area | Built-in `cursor` (ACP) | This plugin (`cursor-sdk`) | Status |
| --- | --- | --- | --- |
| Text / image prompts | Yes | Yes | Works |
| `agent` / `plan` modes | Yes | Yes | Works |
| MCP servers | Yes | Yes (stdio + http/sse) | Works |
| Session persistence / listing | Yes | Yes (local JSONL store) | Works |
| Model catalog | Live, per-model `thought_level` thinking options | Live list, per-model effort-value thinking dropdown | Works |
| Fast mode toggle | Yes (`fast` feature) | Yes (`Off`/`Fast` select, only on models with a `fast` param) | Works |
| Slash commands | Dynamic via `available_commands_update` | Static `/plan` `/compact` `/review` `/commit` | Degraded |
| Tool approval | ACP permission-request flow | Auto-executed; deny cancels run; input questions surfaced | Degraded |
| Revert | None (`supportsRewind*` all false) | Conversation-only (close + fresh agent; `files`/`both` throw) | Works, limited |
| Archive / unarchive | Daemon/ACP session lifecycle | Local close + resume; unarchive no-op; cloud statics unused | Degraded |
| Subagents | ACP-native | `task`-tool calls mapped to provider-owned child sessions | Works |
| Transient retry notices | — | Retry ≤3 attempts, backoff + warning notice | Works (plugin-side) |

## Ship notes

- `package.json` `files` covers `paseo-plugin.json`, both entries
  (`index.client.tsx`, `index.server.ts`), `client/`, `server/`, `shared/`, and
  `icon.svg` — all present. (`README.md`, like `package.json`, ships under npm
  defaults even though it is not listed in `files`.)
- `paseo-plugin.json` `requirements.paseo: ">=0.10.3"` is a valid semver range and
  matches the SDK the plugin typechecks against.
- `package-lock.json` is committed.
- No `prepare`/`prepack`/build script: Paseo compiles both bundles from source at
  load time, and Git installs never run a package manager, so a build-prep entry
  would never execute. Keep publishing from source.
- `private: true` blocks `npm publish`; remove it only if an npm distribution is
  wanted in addition to Git / directory installs.
