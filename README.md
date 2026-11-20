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

Configure your coding tools to use [HallPass](https://hallpassai.com) in a single command — including model selection, reasoning effort levels, diagnostics, and clean uninstall.

## Quick start

Generate a 10-minute pairing code on **[app.hallpassai.com/start.html#connect](https://app.hallpassai.com/start.html#connect)**, then run:

```bash
npx hallpassai@latest HP-XXXX-XXXX
```

## Supported tools & model ecosystems

| Tool | Models & reasoning support |
|---|---|
| **Claude Code** | Anthropic Claude models (`Opus`, `Sonnet`, `Haiku`) · Sets `effortLevel` + `ANTHROPIC_DEFAULT_*_MODEL` aliases in `~/.claude/settings.json` (`/model` & `/effort` ready) |
| **Codex CLI** | OpenAI GPT & Codex models · Configures `[model_providers.hallpass]` + `fast`, `balanced`, and `deep` reasoning profiles in `~/.codex/config.toml` |
| **OpenCode** | All 130+ HallPass models (Claude, GPT, DeepSeek, Gemini, Qwen, Kimi…) · Registers `low` / `medium` / `high` reasoning variants (`Ctrl+T` & `/models` ready) |
| **Copilot CLI** | All OpenAI-compatible HallPass models · Writes `~/.config/hallpass/copilot.env` (`0600`) + idempotent shell profile block |
| **Cursor** | All 130+ HallPass models · Copies API Key, Base URL, and Model ID directly to your clipboard |

Every modified configuration file is backed up to `<file>.hallpass.bak` first.

## Commands & flags

```bash
# Pair and configure (optionally set default reasoning depth: low, medium, high, max)
npx hallpassai@latest HP-XXXX-XXXX
npx hallpassai@latest HP-XXXX-XXXX --reasoning high

# Browse live models grouped by provider or filter by search query
npx hallpassai@latest models
npx hallpassai@latest models --provider Anthropic
npx hallpassai@latest models --search deepseek

# Switch models and/or reasoning depth anytime without re-pairing
npx hallpassai@latest use claude-opus-5.5 --reasoning high
npx hallpassai@latest use --reasoning medium
npx hallpassai@latest use   # interactive TTY model + reasoning picker

# Check configured tools, config integrity, and gateway latency (uses 0 credits)
npx hallpassai@latest status
npx hallpassai@latest doctor

# Full uninstall & cleanup: revokes server API key(s), restores .hallpass.bak backups,
# cleans shell profiles & macOS Keychain, and removes ~/.config/hallpass
npx hallpassai@latest uninstall
npx hallpassai@latest uninstall --agent claude-code
```

Set `DO_NOT_TRACK=1` or `HALLPASS_NO_TELEMETRY=1` to disable anonymous CLI setup diagnostics.
