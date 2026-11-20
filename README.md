<p>
  <a href="https://hallpassai.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hallpassai/.github/main/assets/wordmark.svg">
      <img alt="HallPass" src="https://raw.githubusercontent.com/hallpassai/.github/main/assets/wordmark-light.svg" height="42">
    </picture>
  </a>
</p>

<p>
  <a href="https://www.npmjs.com/package/hallpassai"><img src="https://img.shields.io/npm/v/hallpassai?color=e0f580&labelColor=181916" alt="npm version"></a>
  <a href="https://github.com/hallpassai/hallpassai/actions/workflows/ci.yml"><img src="https://github.com/hallpassai/hallpassai/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://hallpassai.com"><img src="https://img.shields.io/badge/gateway-hallpassai.com-181916" alt="hallpassai.com"></a>
</p>

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

# Preview file changes locally without consuming the pairing code or modifying disk
npx hallpassai@latest HP-XXXX-XXXX --dry-run

# Check configured tools, config integrity, and gateway latency (uses 0 credits)
npx hallpassai@latest status
npx hallpassai@latest doctor

# List live models and switch your configured tool(s) to another model
npx hallpassai@latest models
npx hallpassai@latest use claude-sonnet-4-6

# Restore backups (local config revert)
npx hallpassai@latest undo [--agent claude-code]

# Full uninstall & cleanup: revokes server API key(s), restores .hallpass.bak backups,
# cleans shell profiles & macOS Keychain, and removes ~/.config/hallpass
npx hallpassai@latest uninstall
npx hallpassai@latest uninstall --agent claude-code
```

Set `DO_NOT_TRACK=1` or `HALLPASS_NO_TELEMETRY=1` to disable anonymous CLI setup diagnostics.
