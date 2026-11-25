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

`hallpassai add <model>` makes the model available in Claude Code, Codex, OpenCode, and Copilot CLI. In Cursor, finish by choosing **Add Custom Model** in **Settings → Models**. To start a Claude session directly on a model, run `npx hallpassai run claude <model>`.

For `run` and its alias `launch`, put HallPass options before the tool name. Type native subcommands and flags just as you would after the native executable. For example, `npx hallpassai run codex exec --json "Review git diff"` and `npx hallpassai run opencode run --format json "Explain this change"`. Native help, short version flags, and subcommand help work before pairing. Try `npx hallpassai run codex exec --help`.

A positional model can still follow the harness name. If it shares a name with a native subcommand, use `npx hallpassai run --model <id> <harness>`. Use `--` before a single-word prompt or project name that could be read as a model. A later `--` belonging to the native command is preserved. HallPass-specific launch options such as `--origin` belong before the harness.

Copilot's native `--model` also selects the HallPass API protocol for that session. For example, `npx hallpassai run copilot --model deepseek-v4.1-flash -p "Summarize this diff"` uses Chat Completions even when the saved model uses Responses.

`npx hallpassai run cursor` displays the desktop setup instructions. With arguments it calls the installed Cursor launcher, for example `npx hallpassai run cursor --version`. Editor settings control desktop model routing. `cursor agent` uses Cursor Agent's own authentication.

The [versioned flag inventory](src/native-flags.json) lists command paths, aliases, and option spellings for each client. On a model qualified for hosted search, run `npx hallpassai run codex --search` to give Codex live web access. GPT-6.1 Sol supports live search. HallPass forwards domain filters to the supplier. With `--search`, the answer appears after the supplier finishes. A turn that uses search can record two metered requests, one for tool selection and one for the search-backed answer. The HallPass model catalog marks qualified models with `webSearch: true`. An explicit launch on an unqualified model reports that search is unavailable.

To start Claude Code in Bypass Permissions mode, run `npx hallpassai run claude --dangerously-skip-permissions`. To make Bypass available through **Shift+Tab** and keep your starting mode, run `npx hallpassai run claude --allow-dangerously-skip-permissions`. Claude shows the same first-use warning for both flags. The footer after consent shows the active mode.

If Claude Code reports that its auto-mode classifier gave no verdict for a write, use **Shift+Tab** at the idle prompt until you reach **Manual** and request the edit again. Claude will show the proposed file change for approval. To resume a specific conversation in that mode, run `npx hallpassai run claude <model> --resume <session-id> --permission-mode manual`. [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)

## Commands

```bash
# Sign in via browser OAuth (alias: login) or pass a pairing code
npx hallpassai auth
npx hallpassai auth HP-XXXX-XXXX

# Add a model to compatible, configured tools. The current default stays selected.
npx hallpassai add
npx hallpassai add abliteration-abliterated-model-large-v2
npx hallpassai add deepseek-v4.1-flash --harness opencode
npx hallpassai add claude-opus-5.5 --harness claude-code

# Browse live models or switch default model / reasoning depth
npx hallpassai models --provider Anthropic
npx hallpassai use claude-opus-5.5 -r high
npx hallpassai use   # interactive model picker

# Run a single session in memory without editing dotfiles
npx hallpassai run claude claude-opus-5.5
npx hallpassai run claude --resume <session-id> --permission-mode manual
npx hallpassai run codex gpt-6.1-sol exec "Review git diff"

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
