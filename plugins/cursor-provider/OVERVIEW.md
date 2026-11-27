Cursor SDK adds Cursor's coding agent to Paseo as the **Cursor SDK** provider. It runs the agent through Cursor's official TypeScript SDK (`@cursor/sdk`) in its local runtime, so the agent works on the files of your Paseo workspace and uses the models available to your Cursor account.

Paseo's built-in Cursor provider drives the `cursor-agent` CLI over ACP. This plugin talks to the SDK directly instead. You don't need the CLI, and the composer gets Cursor's live model list with each model's reasoning effort and Fast options.

## Setup

- Requires Paseo 0.11.0 or later on the daemon and the app. Tested on macOS.
- The daemon host needs Node.js 22.13 or later, and npm on the daemon's `PATH` to prepare the plugin. Preparation installs the locked dependencies and bundles the SDK worker. On macOS, Paseo Desktop runs the worker with a standalone Node executable. Set `CURSOR_PROVIDER_NODE` in the daemon environment to choose a different one.
- Open **Settings > Plugins > Cursor SDK** and choose one way to authenticate:
  - **Sign in with Cursor**: opens a sign-in link, so you don't paste anything.
  - **API key**: paste a user or service-account key from [cursor.com/dashboard/api](https://cursor.com/dashboard/api). **Check and save key** checks the key against the model catalog before saving it, which does not spend usage.
  - **Environment**: set `CURSOR_API_KEY` on the daemon, or on a single agent to override the other sources for that agent.
- Signing in to the Cursor CLI does not carry over. Usage bills to your Cursor plan, as it does in the Cursor editor.

## In the composer

- **Models**: the live catalog from your Cursor account, including Composer, Claude, GPT, Gemini, and Grok models. Without a key, the list shows only Composer 2.5.
- **Reasoning effort**: each model's own levels, such as Low through Max, or On and Off for older thinking models. Switching models selects the new model's default level.
- **Fast**: an Off and Fast switch, shown only on models that offer it.
- **Modes**: **Bypass** runs every tool call. **Auto-review** has Cursor's auto-review classifier check each call, and denies any call it would ask you about. **Plan** is read-only.
- **Steering**: a message sent during a turn steers the running turn.
- **Slash commands**: Cursor skills and command files from the workspace and your home folder (`.cursor`, `.claude`, `.codex`, `.grok`, `.agents`, and installed Cursor plugins). `/plan`, `/compact`, `/review`, and `/commit` are included when no skill uses those names. `/compact` summarizes the conversation.

## Sessions

- Text and image prompts, MCP servers (stdio, HTTP, and SSE), token usage, and the context window indicator.
- Sessions are saved on the daemon host and survive daemon restarts. A session that reopens replays its last 20 or so messages.
- Subagents: when the agent has Paseo's tools, it delegates through Paseo, so each subagent is a normal Paseo agent that you can watch and message. Without Paseo's tools, Cursor's own subagents appear as read-only child sessions.
- Rate limits, model capacity errors, and network failures are retried up to 3 times with backoff, and the timeline shows a notice for each retry. Authentication and configuration errors are not retried. A reconnect that lasts more than 20 seconds also shows a notice.

## Data access

- Prompts, attached images, the files and command output the agent's tools read, and the conversation go to Cursor under your account, as they do when you use Cursor directly.
- A pasted API key is saved in this plugin's settings on the Paseo host, in plain text in the daemon's data folder. Apps connected to that host load it into the settings screen, where it stays masked. **Sign in with Cursor** saves the key in `~/.cursor/sdk/auth.json` on the daemon host.
- Sessions are stored in SQLite databases under `~/.cursor/sdk/paseo-plugin/sqlite` on the daemon host, one per workspace folder. Set `CURSOR_SDK_STATE_ROOT` to move them.
- The plugin writes local diagnostics, such as timings, connection events, and error details, to `~/.cursor/sdk/paseo-plugin/diagnostics`, with 14 days of retention and 64 MB per day. Diagnostics never contain prompts, output, or credentials, and are not sent anywhere. Set `CURSOR_PROVIDER_DIAGNOSTICS=0` to turn them off.

## Limits

- Local SDK runs have no approval channel, so the agent never asks for permission. Use Plan or Auto-review to limit what it can do.
- Revert rewinds the conversation only, not files.
- Team commands from Cursor are not available as slash commands.
- An agent system prompt set in Paseo replaces Cursor's own system prompt.

The [README](https://github.com/fidelix/fidelix-paseo-plugins/tree/main/plugins/cursor-provider#readme) covers installation from source, the diagnostics format, and a comparison with the built-in Cursor provider.
