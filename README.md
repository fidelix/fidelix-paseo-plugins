# fidelix-paseo-plugins

Personal Paseo plugin monorepo. Each directory under `plugins/` is an
independent plugin with its own `paseo-plugin.json` manifest, `package.json`,
and git history (imported with history preserved).

Install one plugin from this repo with a `git:` source and its folder:

```bash
paseo plugin add git:fidelix/fidelix-paseo-plugins:plugins/cursor-sdk
```

## Plugins

| Directory | Plugin ID | Description |
| --- | --- | --- |
| `plugins/cursor-sdk` | `cursor-sdk` | Cursor SDK: Cursor's coding agent through the official Cursor SDK, with the live model catalog, per-model reasoning effort, Fast mode, and automatic retry on rate limits |

See each plugin's own README for setup, limitations, and parity notes.
