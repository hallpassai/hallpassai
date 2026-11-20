# hallpassai

Configure your coding tools to use [HallPass](https://hallpassai.com) in a single command — no manual API key pasting or shell reload required.

## Quick start

Generate a 10-minute pairing code on **[app.hallpassai.com/start.html#connect](https://app.hallpassai.com/start.html#connect)**, then run:

```bash
npx hallpassai@latest HP-XXXX-XXXX
```

## Supported tools

| Tool | What `npx hallpassai` configures |
|---|---|
| **Claude Code** | Updates `~/.claude/settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, gateway model discovery) |
| **Codex CLI** | Configures `[model_providers.hallpass]` (`wire_api = "responses"`) + credential helper in `~/.codex/config.toml` |
| **OpenCode** | Registers the `hallpass` provider in `~/.config/opencode/opencode.json` + stores key in `~/.local/share/opencode/auth.json` |
| **Copilot CLI** | Writes `~/.config/hallpass/copilot.env` (`0600`) and adds an idempotent `# >>> hallpass >>>` block to your shell profile |
| **Cursor** | Steps through copying your API key, Base URL, and Model ID directly to your clipboard |

Every modified configuration file is backed up to `<file>.hallpass.bak` first.

## Commands & flags

```bash
# Pair and configure a tool (or all detected tools)
npx hallpassai@latest HP-XXXX-XXXX

# Preview file changes without modifying disk
npx hallpassai@latest HP-XXXX-XXXX --dry-run

# Check configured tools and verify API key health (uses 0 credits)
npx hallpassai@latest status

# Restore backups and remove HallPass configuration
npx hallpassai@latest undo
npx hallpassai@latest undo --agent claude-code
```
