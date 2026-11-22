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

Configure your coding tools to use [HallPass](https://hallpassai.com) in a single command — as your default backend, alongside your existing Claude/ChatGPT/Copilot logins (`--coexist`), or zero-dotfile on demand (`run`).

## Quick start

Generate a 10-minute pairing code on **[app.hallpassai.com/start.html#connect](https://app.hallpassai.com/start.html#connect)**, then run:

```bash
# Default mode (pause or restore native defaults anytime)
npx hallpassai@latest HP-XXXX-XXXX

# Coexist mode: keeps your existing Claude / ChatGPT / Copilot login untouched
npx hallpassai@latest HP-XXXX-XXXX --coexist
```

In interactive terminals, if `hallpassai` detects an existing local subscription login and no `--mode`/`--coexist` flag was passed, it prompts before changing your global default.

## Supported tools & modes

| Tool | Default mode | Coexist mode (`--coexist`) |
|---|---|---|
| **Claude Code** | Configures `~/.claude/settings.json` + curated `/model` picker (`/model` & `/effort` ready) | Writes `~/.config/hallpass/claude-settings.json` + `claude-hp` shim (plain `claude` untouched) |
| **Codex CLI** | Configures `[model_providers.hallpass]` + default in `~/.codex/config.toml` | Writes V2 profile `~/.codex/hallpass.config.toml` (`codex -p hallpass` / `codex-hp`) |
| **OpenCode** | Sets default model + registers compatible catalog models in `opencode.json` (`Ctrl+T` & `/models` ready) | Registers `provider.hallpass` models in `/models` without changing your default `model` |
| **Copilot CLI** | Writes `~/.config/hallpass/copilot.env` (`0600`) + idempotent zsh/bash/fish profile block | Writes `copilot.env` + `copilot-hp` shim with zero shell profile edits |
| **Cursor** | Copies API Key, Base URL, and Model ID directly to your clipboard | Uses Override OpenAI Base URL (keeps Cursor Tab & Claude/Gemini Pro intact) |

## Commands & flags

```bash
# Pair and configure (optionally set default reasoning depth or coexist mode)
npx hallpassai@latest HP-XXXX-XXXX
npx hallpassai@latest HP-XXXX-XXXX --coexist --reasoning high

# Zero-dotfile ephemeral launch (passes credentials/settings in memory only)
npx hallpassai@latest run claude claude-opus-5.5
npx hallpassai@latest run codex gpt-6.1-sol -- exec "Review git diff"
npx hallpassai@latest run opencode deepseek-v4.1-flash

# Add any compatible catalog model to your in-tool `/model` or `/models` picker
npx hallpassai@latest add deepseek-v4.1-flash
npx hallpassai@latest add claude-opus-5.5 --agent claude-code

# Pause HallPass default routing (restores native logins while keeping keys & credits) and resume anytime
npx hallpassai@latest pause
npx hallpassai@latest resume

# Browse live models or switch active default model / reasoning depth
npx hallpassai@latest models --provider Anthropic
npx hallpassai@latest use claude-opus-5.5 --reasoning high
npx hallpassai@latest use   # interactive TTY model + reasoning picker

# Check configured tools, live credit balance, per-request ledger spend, and gateway latency
npx hallpassai@latest status
npx hallpassai@latest usage
npx hallpassai@latest doctor

# Surgical uninstall: revokes dedicated server API key(s), preserves post-install hooks/MCP configs,
# cleans shell profiles & macOS Keychain, and removes ~/.config/hallpass
npx hallpassai@latest uninstall
npx hallpassai@latest uninstall --agent codex
```

Set `DO_NOT_TRACK=1` or `HALLPASS_NO_TELEMETRY=1` to disable anonymous CLI setup diagnostics.
