# Clarook

**See your context. Shape what comes next.**

Clarook is a terminal AI agent for inspecting API exchanges, editing context and configuring how your agent works.

- **See what the model sees.** Inspect request bodies, responses, returned reasoning and tool results.
- **Change what comes next.** Edit or exclude context inside the terminal while keeping the original history.
- **Build your agent.** Choose models, tools, skills and strategies, then save your setup as a preset.

![Clarook setup: independently configurable components](assets/clarook-setup.png)

Configure each component in `/settings`, for the current session or as a saved default.

[中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

## Getting started

Install Clarook:

```sh
npm install -g clarook@latest
```

Requires Node.js 22.19+.

Start it in your project directory:

```sh
clarook
```

On first launch, choose a provider, enter your API key, then select a model and its scope.

Type a task and press Enter to send it. Esc interrupts the turn; `/quit` exits.

Inside Clarook, use `/help` for commands and keyboard shortcuts, and `/settings` for configuration.

Menus use arrow keys to select, Enter to confirm and Esc to go back. Settings show their actions below the list; use ←→ to select one.

Run `clarook --help` for startup options.

To update to the latest release, close Clarook and run:

```sh
npm install -g clarook@latest
```

To run without a global installation, use `npx clarook@latest`.

A prebuilt package is also available in [GitHub Releases](https://github.com/hirovel/clarook/releases): `npm install -g https://github.com/hirovel/clarook/releases/latest/download/clarook.tgz`.

Clarook checks for updates after startup and shows a manual update command. Disable the check in saved defaults with `/settings checkUpdates`, or start with `--no-check-updates`. `/help update` shows update instructions.

## Using Clarook

### Inspect API exchanges

Ctrl+R opens requests in order. Select a request in the transcript with Shift+PgUp/PgDn, then press Ctrl+R to open its received content directly. Inspect sent messages, tool definitions, captured HTTP JSON, replies, returned reasoning and original tool output. In the sent and received views, use ↑↓ to select a block, Enter to expand it and PgUp/PgDn to page through its contents. Saved bodies, reconstructed views and missing records are labeled separately.

The event history saves full tool declarations for the first ordinary request, whenever they change, and when a complete observation restores the current catalog's missing evidence. Unchanged, known catalogs share the previous snapshot. A restored snapshot applies to later requests, not earlier gaps. Historical definitions remain inspectable after reload without optional recording attachments; older requests without sufficient evidence are labeled unavailable. These snapshots stay in the local history and do not add messages to the model input.

The received view includes replacement previews for `edit` and submitted content for `write`, alongside the tool's result state. Complete arguments remain available. These previews describe submitted text, not full-file snapshots.

### Edit context

Use Ctrl+R to inspect past requests and Ctrl+E to review the current projected context. The draft is excluded; sending may compact history or append context. Edit active system instructions, messages and tool results in the internal editor. Exclude messages, restore edited text, or rewind context to an earlier step. Original content and edit records remain available for comparison. Edits to summarized or cleared content and rewinds across a summary are refused because they would not produce the promised input. Retry selects an assistant reply from the active context.

System instructions keep each section's identity, text, source and enabled state in the event history. Select the system row in Ctrl+E, press Enter to open its sections, then use `e` to edit a section or Enter to switch it on or off. `a` adds or edits Custom instructions, including when the system is empty. `/edit N system` opens the same list; `/edit N system SECTION_ID [text]` edits a specific section. Disabled sections keep their text across restarts. Initial instructions are generated once. Ordinary continuation, history resume and skill discovery preserve the saved document, including your edits to Skills. Comparisons include identities, sources, enabled state and deleted or disabled text. Literal system instructions appear as an editable Custom section. The current/defaults setup operation explicitly rebuilds the composition from the selected settings.

Excluding history also marks the changed prefix for Anthropic's existing conservative thinking-replay policy: earlier blocks stay eligible, later historical blocks are omitted from the request. Recorded content remains inspectable. Chat reasoning keeps its configured replay behavior.

Known tool-definition changes omit earlier signed Anthropic thinking before sending. Blocks produced from the cleaned input can be replayed while definitions stay stable and the existing model and context-edit checks allow it. Returning to a previous definition does not restore omitted blocks. Original records remain available.

Legacy requests without complete tool-definition evidence retain their original signed blocks under the existing model and context-edit checks. Missing evidence alone does not invalidate them. Current declarations do not prove historical definitions, and replay eligibility does not depend on optional recordings. Server acceptance is not verified locally.

Summaries append paths referenced by read and write/edit calls. These lists identify calls, not confirmed file operations; inspect tool results to check their outcomes.

Compaction comparisons show the effective context before the whole compaction, including edits, exclusions, earlier summaries and previously cleared results. Messages retained in the resulting context, such as the protected session directory, are excluded from the replaced-message list and its totals. Ctrl+E uses the same content. A pipeline can change this input before its summary call; inspect the summary request separately for that call's input. Raw originals remain in Events. Source text displays terminal controls as visible escapes. In `replay --compaction N --json`, `covered` and `cleared` contain effective messages; the corresponding `*Indices` identify their source events.

Input comparisons separate document changes, unchanged message text, complete tool definitions and provider-dependent replay state. System edits show the first text difference within a section when its recorded identity matches. Captured HTTP bytes and JSON structure are compared separately; missing captures remain unknown. These differences do not prove cache reuse. Reported cache usage stays separate.

Each action states whether it changes the next input, sends a request immediately or creates a session file. After sending, inspect the captured request in Ctrl+R to check what was actually sent. Intervening log records appear in folded rows; select one and press Enter to inspect them.

While work is running, Enter queues steering input and Alt+Enter queues a follow-up for the end of the current turn. Input left undelivered when work ends stays paused, including after cancellation, failure or a step limit. A new question does not send those paused messages; use `/session inputs` to edit, remove or explicitly continue them.

Context estimates include the current tool definitions when no valid API measurement is available. A valid measurement already includes tools and is extended by newly added messages. Model changes, recorded tool changes and new images invalidate that baseline. Local estimates leave image tokens, private replay data and provider framing unmeasured; historical API usage remains available for comparison.

When complete declaration history is available, context estimates and automatic compaction compare the active tool names, descriptions and parameters with the measured request. Same-name MCP updates are detected before a new snapshot is saved. A valid measurement for the current declarations takes over without counting tools twice.

Interrupted replies keep their reported usage for inspection, but do not provide a complete context baseline. Forked children start their own measurement scope. Custom assembly requests estimate their actual message text; their measurements do not carry over to the standard projection. Automatic compaction still checks the standard projection before custom assembly.

`pnpm checkup <session.jsonl>` reports the observed gap between each stored prediction and the same request's reported input, including a summary of absolute and relative gaps. Its drift check measures stability, not accuracy; missing or interrupted input measurements are excluded from the gap summary.

### Configure your setup

`/settings` separates the current session from saved defaults. Select tools and automatic skills, configure skill directories, model effort and context strategies. Preview status-bar layouts and toggle individual components. Save and load named presets.

Keep tool definitions stable within a conversation when possible. Put task-specific preferences in messages; edit tool descriptions when you want to change their general guidance. Definition changes may reduce prompt cache reuse. MCP refreshes preserve the relative order of existing tools while applying updated definitions and executors.

Optional cost estimates cover the main session only, excluding child sessions. They use reported tokens and configured or catalog rates and are not a bill.

Skills are manual by default: `/name your request`. Automatic selection is optional. Skills mode, source directories, automatic range and loading method are saved for future session preparation; they leave the current document and tools unchanged. A new session or explicit current/defaults rebuild can use the saved settings. History resume keeps its recorded setup. Initial instructions and runtime skills share one discovery result; runtime resources may be discovered again after a restart without rewriting saved instructions. Skills follow the session's tool approval rules; skill metadata does not grant permissions. MCP tools and JavaScript/TypeScript extensions add capabilities or replace strategies.

MCP tool refreshes use a complete paginated list. Repeated cursors or more than 100 pages reject the refresh and keep the previous catalog. Closing a stdio connection also cleans up its local pipes and remaining POSIX process group when the direct server has already exited.

Extensions read `log.events` as an immutable snapshot. Read the property again to see later events; copy the array before sorting or reversing it. Append new facts through `log.append`.

Context management includes Pi, Codex, ZCode and OpenCode reference compositions. New setups default to the Pi reference. Choose a composition, then adjust its trigger, recent-history budget, summary template, output limit and application rule. Details show the actual prompt, output format and differences from the source implementation. Use a `.md` file for your own summary prompt. These are text-based adaptations sharing Clarook's compaction loop; existing explicit settings take precedence.

For earlier compaction, set `compactionRatio` in `/settings`: `0` disables it; `0.8` is a starting point when enabled. Context length can affect information use, so earlier summaries may improve focus, but can lose detail and add requests. The context reserve may trigger sooner. `/compact` gives you manual control.

### Work and resume

Built-in tools read, write and edit files, run commands, search file contents and paths, and fetch pages. The agent continues through tool calls until the model finishes. In fullscreen mode, PgUp/PgDn pages through the transcript; Shift+PgUp/PgDn selects a request, and Enter folds or expands it when the input is empty. Esc closes a view or returns to live output before interrupting a running turn. `/session` creates, resumes and forks sessions. Type in the resume list to search all saved sessions by their latest user message, model or path. History, API bodies and original tool output are stored locally.

Built-in `edit` accepts `path` and a nonempty `edits` array. Each item has `oldText`, `newText` and optional `replaceAll`. Every item searches the same original file; matching, ambiguity or overlap errors leave the whole group unwritten. Each item requires a unique match unless it explicitly sets `replaceAll: true`. Valid changes are written together after all checks. The former top-level `oldText`/`newText`/`replaceAll` input is rejected. Tool previews show each requested replacement and its range; historical parameters remain readable.

The `userMessagesOnly` child scope inherits prior user messages with current edits and exclusions applied, including early requirements covered by compaction. Tool results and assistant steps are omitted. Those early messages can increase child input size.

Each built-in `bash` call starts in its configured working directory. `cd` affects only that call; use `cd path && command` to run elsewhere. Shell directory changes do not carry over to later calls.

Sessions remember their directory. Resuming from another directory keeps the saved root for tools, attachments, completion and project resources. Use `/session directory` to choose a new root, or `/session directory /path` to provide it directly. Older sessions without a recorded root and sessions whose directory has moved use the same chooser; the confirmed directory is saved in the original history. For noninteractive use, run `clarook sessions directory SESSION_FILE DIRECTORY` before resuming.

Directory changes preserve saved instructions and manual system-prompt edits. They do not reload the new directory's `AGENTS.md` or rewrite old paths. Choosing the existing current/defaults setup source rebuilds its prompt and work configuration. The current execution directory is recorded separately, remains visible after compaction, and can be changed through the session operation rather than a context edit. Historical requests keep their original directory facts.

Use `@path` to attach a UTF-8 text file, or `@"path with spaces.txt"` for a path containing spaces. Type `@` to choose a file path; completion reads names only, and contents are attached when you submit. Multiple references, such as `Compare @a.txt @b.txt`, attach both files. Files over 50 KiB, binary files and invalid UTF-8 are skipped with a notice. Ctrl+V pastes an image; Alt+I lists attached images and lets you remove one.

Attachments come from your original input, independently of prompt-template substitution. For an installed `/review` template, `/review @a.txt @b.txt` attaches both files even if the template only uses `$1`. Templates and skills generate message text: their own `@path`, a constructed `@$1`, or a leading `!` stays text and does not automatically attach files or run a user shell command. Later model tool calls follow the session's approval rules.

A text-only response that reaches its output or context limit is kept as incomplete and stops without automatic continuation. Tool calls in a truncated response are not executed.

Tool approval checks the argument values that execution will use, after any local validation and supported scalar conversion. Arguments rejected by local validation return a tool error without prompting for approval; the original model arguments remain in history. OpenAI-compatible streams finish at `[DONE]` without waiting for the HTTP connection to close, preserving preceding usage information. The adapter still requires a valid completion reason before executing tool calls.

Path approval rules match the resolved target using normalized project-relative or absolute patterns with `/` separators. For example, `src/../private.txt` is checked as `private.txt`, while `..cache/file.txt` remains inside the project. Use `edit:src/**` rather than patterns containing `./` or unresolved parent segments; raw input spelling does not grant additional access or cause an extra denial.

While a model generates tool calls, the TUI shows each tool's name and received argument bytes. Retry, cancellation and failure clear unfinished tool previews. Execution uses the complete response after validation and approval. Provider and Agent integrations receive text, reasoning, tool argument updates and attempt lifecycle through the single `onStream` callback; the former `onDelta` and `onReasoning` callbacks have been removed. Partial updates are temporary display data, not saved conversation facts.

Extensions can record side events without changing which request owns its captured input and HTTP bodies. Live and reopened transcript views follow the committed event order, including events appended by synchronous observers.

Extensions can supply `slots.beforeToolCall` to return `{ args: replacement }` before approval; returning nothing preserves the prepared arguments. Replacement values go through the existing JSON argument validation and scalar conversion. Invalid replacements and preparation errors return a tool error without execution. Approval reads a fixed final snapshot, and execution receives a private copy. The original model call remains unchanged in history and future model inputs.

Each call that reaches approval records its final parameters as a `tool/arguments` event, tied to the original assistant event and call ID. Inspect **Model arguments** and **Prepared arguments** side by side, including denied calls and sessions reopened without body attachments. Preparation does not prove approval or execution. Recording start events reference the parameter fact instead of duplicating it. The hook uses existing slot replacement rules; factory-created children receive their own hook instance, while static SDK tool arrays keep inherited slots.

The `task` tool delegates work to a child context. Follow up with `resume: "sub-N"`: the child keeps its original type, selected provider/model, actual tool names, per-run step limit and remaining delegation depth, including after restarting Clarook. Raising the current depth does not expand its delegation rights; reducing it below the original requirement rejects the follow-up. Missing original resources or an explicit type change also reject it before model execution. Older child logs without an execution identity remain readable but cannot be resumed. Approval follows the parent's current rules; model aliases and tool implementations are not version-pinned.

Open these entries in `/settings`, switch to **Saved defaults**, and restart to use the new values. They also work in named presets and command-line flags:

| Setting under `defaults` | Default | Meaning |
| --- | --- | --- |
| `maxSteps` | unset / `null` | Main model steps per turn; no limit by default. `--max-steps N\|none` |
| `subagents.maxSteps` | `null` / `inherit` | Steps per child run. A type's limit wins, then this setting, then the parent's limit. `--subagent-max-steps N\|inherit` |
| `subagents.depth` | `1` | Child generations from main. `1`: children cannot delegate; `2`: grandchildren allowed. `--subagent-depth N` |

One model response and its tool batch count as one step, even when the batch contains several calls. Compaction requests and transport retries are outside this count. A low cap can stop unfinished work; it does not tune reasoning effort, output tokens or concurrency. These numeric settings accept positive integers; `none` removes the main cap, while child `inherit` uses the parent cap, including no limit. Saved changes preserve the first constraints of existing children. Move old top-level `subagents.maxSteps` and `subagents.depth` into `defaults.subagents`; old locations now fail at startup.

### Run your own commands

Type `!git status` and press Enter to run it and include the command and result in the next model context. Use `!!git status` to display and save both without adding them to context. `/shell` prepares the same input. Neither scope sends an API request.

The footer shows **Shell** and the selected context scope. Shift+Tab switches scope; idle Esc keeps the text and returns to chat. Typed and pasted prefixes work alike, including fullwidth `！` and `！！`.

Commands run while idle, from the project directory, with a 120-second timeout. Each command starts fresh; `cd` applies only to that command. Busy commands stay in the input. Images stay attached for chat, and `@path` is passed literally to the shell. Interactive programs requiring terminal input are not supported. Long output is saved in full with a readable path and a bounded preview.

Esc or a timeout requests cancellation, then ends local waiting without waiting for inherited output pipes. Captured output is kept; later output is no longer collected. The result is marked unknown because descendant termination and external effects are unverified. Windows uses `taskkill`. Normally completed commands still collect output until the streams close.

Providers support OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. See the [relay configuration example](examples/config.relay.json) for compatible endpoints.

## Development

Clone the repository, install dependencies and run Clarook from source:

```sh
git clone https://github.com/hirovel/clarook.git
cd clarook
pnpm install
pnpm tui
```

Before submitting changes, run:

```sh
pnpm check
```

Compare configurations with real API calls from the source checkout:

```sh
pnpm evaluate validate evals/tool-descriptions.json
pnpm evaluate run evals/tool-descriptions.json .preview/evaluations/run-01
```

The experiment file sets the model, baseline, candidates, tasks and repetitions. Results include independent artifact checks, session records, CSV and an HTML report. `pnpm evaluate report <result-directory>` rebuilds the report without API calls. Each run needs a new output directory. Results apply to the tested model and tasks; configurations are never adopted automatically.

## License

[MIT](LICENSE)

Adapted summary templates retain their [third-party notices](THIRD_PARTY_NOTICES.md).

Formerly Clari.
