# fidelix-paseo-plugins

Personal Paseo plugin monorepo. Each directory under `plugins/` is an
independent plugin with its own `paseo-plugin.json` manifest, `package.json`,
and git history (imported with history preserved).

Install one plugin from this repo with the `--path` selector:

```bash
paseo plugin add fidelix/fidelix-paseo-plugins --path plugins/cursor-provider
```

## Plugins

| Directory | Plugin ID | Description |
| --- | --- | --- |
| `plugins/cursor-provider` | `cursor-provider` | Cursor coding agent via the official Cursor SDK (local runtime), with retriable-failure detection and retry |

See each plugin's own README for setup, limitations, and parity notes.
