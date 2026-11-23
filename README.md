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

## One-time setup

Run `npx hallpassai` in a terminal to choose a tool, or name it directly.

```sh
npx hallpassai setup codex
```

Choose **Use HallPass credits** to make HallPass the default for new conversations. From then on, open your tool normally.

```sh
codex
codex resume
```

**Keep my current default** sets up a separate way to use HallPass. Codex has a native `codex -p hallpass` profile. OpenCode offers HallPass in `/models`. Claude Code and Copilot have separate launchers whose paths appear after setup. With Copilot as the default, open a new shell or source the file printed by setup. Cursor uses its desktop Models settings.

Rerunning setup for the same tool reuses its saved HallPass credential. To pair from a remote terminal, get a code from [HallPass Connect](https://app.hallpassai.com/start.html#connect). For unattended setup, specify both a tool and a routing choice.

```sh
npx hallpassai setup codex HP-XXXX-XXXX --default
```

## Cursor Desktop

Run `npx hallpassai setup cursor` once. In **Cursor Settings → Models → API Keys**, enable **Override OpenAI Base URL** and save the URL from setup. Then paste the Cursor-scoped HallPass key into **OpenAI API Key** and enable it. Setup copies the URL, key, and model ID in that order on supported desktop terminals.

Add the model ID to Cursor and select it in an Ask or Agent chat. Both `gpt-6.1-sol` and `deepseek-v4.1-flash` work with this flow. Run `npx hallpassai usage` to see the HallPass request. To return to your Cursor subscription, disable the OpenAI key and the base URL override, then select **Auto** in chat.

## Commands

```bash
# Sign in via browser OAuth (alias: login) or pass a pairing code
npx hallpassai auth
npx hallpassai auth HP-XXXX-XXXX

# Register a model in the Claude Code or OpenCode picker
npx hallpassai add
npx hallpassai add deepseek-v4.1-flash --harness opencode
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
npx hallpassai pause codex --continue
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

To go back to ChatGPT, close the Codex conversation and run `npx hallpassai pause codex`. When restoring a ChatGPT login, this also routes saved HallPass threads to ChatGPT. Reopen the thread with `codex resume`. Use `npx hallpassai pause codex --continue --model <subscription-model>` if the original model is unavailable on your plan or your Codex picker hides the thread. Resuming sends the prior conversation to the chosen provider. Some providers reject model-specific history.

Earlier releases of `add` changed the active model for Codex and Copilot. Use `hallpassai use <model> --harness codex` or `--harness copilot` for that operation.

Set `HALLPASS_NONINTERACTIVE=1` in CI, or `DO_NOT_TRACK=1` to disable anonymous CLI setup diagnostics.
