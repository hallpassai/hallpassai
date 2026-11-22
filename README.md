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

Connect Claude Code, Codex, OpenCode, Copilot CLI, and Cursor to 137 models on [HallPass](https://hallpassai.com).

## Quickstart

```bash
# 1. Sign in via browser OAuth and connect your tools
#    (detects existing Claude / ChatGPT / Copilot logins and asks before touching them)
npx hallpassai auth

# 2. Browse popular models (arrow keys + type to filter) or add one directly
npx hallpassai add
npx hallpassai add deepseek-v4.1-flash
```

On SSH or headless machines, generate a setup code at **[app.hallpassai.com/start.html#connect](https://app.hallpassai.com/start.html#connect)** and run:

```bash
npx hallpassai auth HP-XXXX-XXXX
```

## Commands

```bash
# Sign in via browser OAuth (alias: login) or pass a pairing code
npx hallpassai auth
npx hallpassai auth HP-XXXX-XXXX

# Add any compatible model to your tool's /model or /models menu
npx hallpassai add
npx hallpassai add deepseek-v4.1-flash
npx hallpassai add claude-opus-5.5 --harness claude-code

# Browse live models or switch default model / reasoning depth
npx hallpassai models --provider Anthropic
npx hallpassai use claude-opus-5.5 -r high
npx hallpassai use   # interactive model picker

# Run a single session in memory without editing dotfiles
npx hallpassai run claude claude-opus-5.5
npx hallpassai run codex gpt-6.1-sol -- exec "Review git diff"

# Pause default routing (restores native logins) and resume anytime
npx hallpassai pause
npx hallpassai resume

# Check configured tools, live credit balance, and gateway health
npx hallpassai usage
npx hallpassai status
npx hallpassai doctor

# Clean uninstall: revokes server API keys, removes HallPass files & keychain entries,
# and preserves your hooks and MCP servers
npx hallpassai uninstall
npx hallpassai uninstall --harness codex
```

Set `HALLPASS_NONINTERACTIVE=1` in CI, or `DO_NOT_TRACK=1` to disable anonymous CLI setup diagnostics.
