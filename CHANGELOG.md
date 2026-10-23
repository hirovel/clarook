# Changelog

All notable changes to clari. The format follows Keep a Changelog; versions follow semver.
Design decisions behind each entry are recorded, with reasons and alternatives, in the internal architecture document.

## [Unreleased]

### Fixed

- Preserve visible Responses refusal text in streamed replies and completed responses. Merge complete snapshots without repeating text, and retain the existing message, usage and stop behavior.

## [0.1.3] - 2026-10-08

### Added

- Expand `edit` replacement previews and `write` submitted content in the received inspector. Keep complete arguments and tool results adjacent, label success, error, unknown and missing results, and preserve recorded content and model input.
- Search all saved sessions in `/session resume` by the latest user message, model or path. Show task text first, keep full metadata in the selected detail view, and preserve the existing setup selection and draft on cancellation.
- Show Shell mode with include/exclude context choices in the input footer. `!command` and `!!command` execute on Enter, including pasted and fullwidth prefixes. `/shell` prepares input; Shift+Tab switches scope and idle Esc keeps the text for chat. Keep complete key/action pairs together when narrow windows wrap hints.
- Run user commands from chat: `!command` adds the result to the next context; `!!command` saves and displays it locally. Show the scope before execution. Reuse Bash capture and the existing running lifecycle; keep busy commands as drafts without calling the API or queueing them. Restore unfinished commands as unknown without rerunning them. Windows cancellation reports unverified descendant termination.

### Changed

- Show one compact identity per tool call in the received inspector. Label arguments, original output and model results by role; keep the selected call visible while paging. Preview argument fields when folded and preserve the complete JSON when expanded.

- Group each received tool call with its arguments, original output and model result. Use thin dividers and explicit result states; preserve selection while evidence arrives and keep unmatched records visible.
- Clarify that the session log keeps messages, tool results and context changes; not every interface action is saved. Keep approval reasons in the existing tool results without adding a separate approval history.
- Remove single-letter menu shortcuts. Show model scope, session setup, settings actions, pending-input actions and shutdown actions explicitly. Arrow keys or numbers select; Enter confirms. Keep letters available in search and text inputs.
- Page through the fullscreen transcript with PgUp/PgDn, including long replies. Use Shift+PgUp/PgDn to select a request for folding. Keep menu paging and draft editing separate; update help and both READMEs.
- Keep the editing cursor, Apply/Cancel actions and controls visible in short text-editor dialogs. Shorten explanatory text to fit, retain clipboard failure notices, and restore the full view when resized.
- Make input hints describe the current Enter and Esc actions. Reserve room for input and controls in short fullscreen terminals, shorten status readings without changing widget settings, and restore them when the window grows.
- Keep request bodies in place while folded so replies arriving during a run remain available when expanded. Show selection on open request titles and skip leading blank lines when jumping to a request.
- Use the same gold highlight and `›` cursor across menus, settings and inspectors. Keep expansion markers and keyboard behavior; avoid wrapping padded approval choices in narrow terminals.
- Share setting mutations between menus and commands. Keep current-session changes and saved defaults distinct, and report failures without interpreting display text.
- Use one recording path for regular and compaction requests, including adapter inputs, HTTP attempts, retries and failures. Keep their response handling separate.
- Fix inspector pagination and section scrolling. Reserve room for selected content and controls before fitting optional headers in short terminals; keep edit state and read-only reasons visible.
- Show gaps between context event IDs as folded log groups. Inspect individual records and JSON, then return to the selected group; keep model input unchanged.
- Distinguish request numbers from event IDs and state when context actions take effect. Label token units, relative size and small percentages; show unchanged text separately from measured cache hits.

### Fixed

- Attach quoted file paths containing spaces. Preserve valid UTF-8, BOM and line endings; skip invalid UTF-8 with a visible reason instead of silently replacing bytes. Keep path deduplication, complete recorded input and the existing 50 KiB limit.
- Keep rate-limit and server-error hints factual when retries are disabled. Retry history remains available in the request records.
- Keep errors from a new operation visible after an earlier request failed. A previous request error no longer suppresses a later manual compaction failure.
- Preserve failure text across custom subagent runners, extension initialization, settings saves, session switches and text editing. String and null rejections no longer hide the cause or replace it with a secondary error; failed work keeps its existing recovery and cleanup behavior.
- Convert non-Error tool failures to text before recording and returning them to the model. A custom tool rejecting with a string or null no longer breaks the next request.
- Finalize received text and thinking when a streamed request fails. Keep the incomplete response visible and separate from later replies without adding it to model context. Ignore late display callbacks after the interface stops while preserving received records.
- Batch thinking display updates with reply updates using the existing frame timer. Keep the first fragment immediate and the final message complete; release pending display work on completion and UI shutdown.
- Resolve Windows `taskkill.exe` from the system directory so cancellation does not depend on PATH. Keep failures visible and descendant termination unverified.
- End local Bash waiting after `taskkill` returns on Windows, including cancellation and timeout. Keep captured output, detach inherited pipes and report an unknown outcome without claiming descendants have stopped. Preserve the original cancellation timing test.
- Remove terminal control sequences from displayed tool output, command and file previews, model text, retry notices and extension errors, including subagent views. Preserve original events and model inputs, application colors, file links and explicit copy actions.
- Keep carriage-return progress fragments on separate display lines. Show control characters explicitly in original-message, tool-definition, HTTP JSON and event JSON inspectors without changing the recorded or transmitted content.
- Keep missing tool-result notices visible before long call IDs in narrow received views. Do not infer that a missing result is still running.
- Show every tool result in the received inspector, including denied calls, unknown tools and invalid arguments without captured output. Keep original output separate and match it by call ID.
- Cancel pending tool approvals when the turn is interrupted. Close the prompt, stop waiting and mark unexecuted calls as interrupted, including inherited subagent approvals; preserve drafts and queued input during shutdown.
- Keep approval actions visible with long tool names and denial reasons in short terminals. Page through complete parameters and reasons, preserve the parameter reading position when returning, and send the full reason to the model.
- Parse copied code blocks with the Markdown parser already used by the terminal UI. Handle tilde fences, longer fences, nested blocks and indented code; keep whole-reply copies unchanged.
- Let unknown tool results use the normal fold and unfold controls. Keep their status, recorded reason, duration and recovery entry visible without changing execution or retry behavior.
- Open the selected transcript request's received content with Ctrl+R. Keep the latest-request list when no request is selected, and preserve the draft and reading position when returning.
- Format context-window tokens consistently in the header, status bar and inspectors; remove the header's separate 1024-based conversion.

## [0.1.2] - 2026-10-01

### Changed

- Publish Clari as `@hirovel/clari` on the npm registry. Use `npm install -g @hirovel/clari@latest` for installation and updates, and `npx @hirovel/clari@latest` for temporary use. Keep the `clari` startup command. Check the npm `latest` version at startup so the update notice matches the installation source. Keep the prebuilt GitHub Release package as an alternative; uninstall the old unscoped package once before upgrading from 0.1.0 or 0.1.1.

## [0.1.1] - 2026-09-30

### Added

- Check for a newer stable GitHub release asynchronously after TUI startup. Show a manual update command without changing input or model context. Add `checkUpdates` to saved settings and presets, startup flags, and `/help update`. Limit the check to three seconds; failed checks leave normal operation unchanged.

## [0.1.0] - 2026-09-30

### Changed

- Distribute a prebuilt installation package through GitHub Releases. Document permanent installation, startup and manual updates in both READMEs. Add repository metadata and remove the npm publication block; keep updates outside the running agent.

- Document `clari` as the startup command for installed copies. Distinguish terminal `--help` from in-app `/help` in both READMEs, and include the npx help command.

- Remove the renderer-export caption from both READMEs. State the first-launch login steps, Enter to send, Esc to interrupt and `/quit` to exit.

- Adopt the MIT license. Introduce API inspection, context editing and configurable presets with three highlights in both READMEs. Add concise usage sections for expanding recorded content, editing context, configuring components and resuming tasks. Replace acceptance stories and old screenshots with one setup preview exported from the terminal renderer.

- Show each setup component with its name and key values, separated by thin rules. Keep summaries scoped to the current session or saved defaults. Fit navigation to rendered row heights, page by visible items and wrap scope hints on narrow terminals. Preserve existing setting actions and draft input.

- Keep the tail and input marker visible when typing long paths, values or preset names in the setup view. Slice by terminal columns for wide characters; preserve the complete value.

- Configure skill discovery directories in `/settings prompt.skills.sources`. Keep four enabled defaults, toggle sources, add custom paths, and remove custom sources without deleting files. Rescan idle sessions immediately, keep in-flight runs unchanged, and preserve loaded instructions. Save source choices with defaults, presets and session setup. Preserve spaces in typed setting values.

- Treat failed Responses terminal events as errors even when details are missing, and reject incomplete responses for reasons other than the output-token limit before handing over tool calls. Keep existing truncation recovery. Use English for fixed tool-validation and stream-error text.

- Recognize nested transport error codes when deciding retries and classifying failures. Stop automatic replay after streamed text or reasoning, across all three provider adapters; preserve the received bytes and pause pending input after failure.

- Include underlying error codes in network failure text for retries, final errors, recorded HTTP attempts, login verification, model listing and `once` output. Preserve the original error and retry policy; do not expand nested diagnostic bodies or request objects.

- Report individual `@path` attachment read failures without losing the input or other readable attachments. Read each accepted file once for both binary detection and text; keep the existing 50 KiB limit and literal treatment of missing paths.

- Keep the TUI available when a prompt-template directory or file cannot be read. Show the source path and reason, continue loading normal templates, and preserve the existing project-over-user precedence.

- Show all four skill discovery locations and their order in `/inspect skills` and CLI help. Report unreadable directories, unreadable skill files and duplicate names without preventing other skills from loading. Keep the existing first-name-wins order. Reclaim temporary artifacts in skill, parity, registry, Responses and edit-tool tests through the existing test isolation root.

- Page through help and other main-screen output with PgUp/PgDn before the first request. Keep step selection once requests exist. Isolate project MCP test sessions in their temporary directory.

- Run the default Vitest suite with at most two worker processes. Keep all tests and existing timing limits; reduce contention between rendering measurements and subprocess checks.

- Pause undelivered input after a failed turn, requiring explicit continuation in `/session inputs`. Keep unapplied pending-message edits when the original message has already been delivered; the main draft stays intact.

- Preserve internal line breaks, indentation and repeated spaces in command text, including skill requests, templates, inline context edits and compaction instructions. Keep repeated spaces in session paths and approval rules. Expand template placeholders in one pass without reinterpreting the supplied text.

- Preserve the off option when the model catalog declares both a thinking toggle and effort levels. Explicit model settings still take precedence. Request failures without an inline error body now link to recorded response details instead of claiming that no response was received.

- Correct CLI help to describe manual skill invocation as the default and distinguish automatic catalogs in the system prompt from those in a tool definition.

- Cancel `/model list` when its view closes or is replaced. Discard late catalog and capability results without closing a newer menu. Report default-save failure separately from a successful model switch, with `/model default` available for retry. Keep a short failure summary visible after full details on narrow terminals.

- Ask before exiting on Ctrl+C, with Continue selected by default. Cancel returns to the previous view with drafts, unapplied edits and pending approvals intact. Repeated Ctrl+C does not confirm or force shutdown; `/quit` remains a direct shutdown command.

- Keep status-bar exports in the same order as the live screen. Show descriptions for checkbox readings, wrap failure messages and recovery actions on narrow terminals, and label context totals as unmeasured when no API baseline is available. The preview server listens on loopback only.

- Add four status-bar layouts, defaulting to Signal rail. `/settings` previews the highlighted layout with live readings and offers a checkbox menu for visible readings. Selected readings wrap on narrow terminals; model and effort appear below the input. Urgent failures remain visible regardless of the layout.

- Hide monetary estimates by default, including static rates in model pickers. `showCostEstimate` opts in to a labeled token-based estimate in the TUI; one-shot JSON uses `--show-cost-estimate`. If usage or pricing is incomplete, show the reason instead of a partial total. The optional Classic status style keeps the capacity meter on wide terminals.

- Before valid provider usage is available, label context size as a message estimate plus the active tool count, with the total pending measurement. Explain the estimate's scope in request details and `/context`; treat all-zero usage as missing and keep the existing compaction threshold and event format.

- Report an interrupted turn as interrupted even when an adapter returns a late completed reply. Keep the received reply in the event log. Pending input cannot be resumed while the turn is stopping, and an input is not unpaused before its first delivery is recorded.

- Run `/compact` through the agent activity cycle. Esc interrupts it, exit waits for it, and input queued during compaction continues afterward. A standalone compaction does not start a normal model request.

- Mark visual token cost as unknown before sending a new image, and show the provider's measured input beside the next-context estimate. If an attempted compaction makes no progress, record its reason and keep the original images and context available for manual editing.

- Format the generated model snapshot as part of `pnpm models:update`, so a normal refresh leaves the repository checks green without a separate manual step.

- Use `deepseek-flash` as the new-install default and list the current Flash and Pro names in the DeepSeek template. Refresh the generated offline model-capability snapshot.

- Remove the outdated `HANDOVER.md`; keep current working rules in `AGENTS.md` and the module map in the internal architecture document.

- Keep separate `grep` and `glob` tools but run both through one cancellable, bundled ripgrep process. Apply the search limits to the whole call, report invalid patterns directly, and remove tool-description rules that forbid shell searches.

- Allow one `fetch` call to raise its response byte budget with `maxBytes`. Keep the 5 MiB default, do not cache stopped downloads, and leave any retry to the agent or user.

- Let `bash` commands finish regardless of output volume. Stream the complete captured output to Recording, keep a bounded 50 KiB tail for the model, and show the byte count and raw-output path. Timeout, interruption and recording-failure handling remain in force.

- Let `fetch` read local and private HTTP(S) addresses under the same tool approval rules as other network-capable tools. Remove its separate `allowPrivate` setting, connection guard, and fixed per-host request quota.

- Read files above 20 MiB by explicit line range without loading the whole file. Keep the default 50 KiB / 2000-line response budget; `maxOutputBytes` raises the byte budget for one read call.

- Review project `.mcp.json` in the TUI before connecting its effective servers. Remember trust by project path and file digest; changed files require review again. One-shot mode stops with a clear message for an untrusted project configuration.

- Share context field rules across menus, commands, comparison and restore. Menu editing enters the editor directly; application rechecks running and read-only state.

- Edit context text and tool descriptions inside the terminal, with explicit Apply and Cancel actions. Preserve the message draft and original history. Remove Ctrl+G, external editor processes and temporary edit files.
- Label where skill catalogs enter requests: system prompt for read loading, tool definition for skill loading, and no catalog for manual invocation. Distinguish catalogs from loaded instructions.

- Default skills to manual invocation. Add live automatic selection and a shared checkbox range, saved in defaults and presets. `include: "all"` includes future discoveries; arrays keep specific names. Replace `prompt.skills.list` with `mode` and `include`; the old key reports an error. Dedicated skill tools carry the selected catalog without repeating it in the system prompt.

- Keep skill instructions literal and append invocation arguments as a separate request. Skills no longer substitute `$1`, `$@` or `$ARGUMENTS`; prompt templates still do.

- Shorten both READMEs to setup, usage, configuration, sessions and development. Correct outdated defaults and dependency claims.

### Fixed

- Bound masked login input and verification errors to the terminal size, with paged error details. Cancel the actual model-list request on Esc or dialog closure, and reject malformed model-list responses. After verification fails, explicitly save an unverified key with Ctrl+S and choose a configured model. Show when an environment key still takes precedence. Read UTF-8 BOMs in configuration and credentials, and avoid credential excerpts in parsing and login errors.

- Reuse the scrolling list picker in login for providers and models. Keep long selection errors readable through the detail pager and retain the selected model for retry. Size the compact fallback from the actual wrapped footer height so small menus stay inside the terminal.

- Keep all command-palette matches available to arrow-key navigation instead of discarding entries after the first ten. Scroll the visible rows, bound the view to the terminal size, and let PgUp/PgDn read the selected entry's full label and description.

- Settle menu waits when a dialog is closed or replaced. Cancel login verification with Esc and ignore late results after cancellation or closure; keep credential-save and model-switch errors in the dialog for retry. Keep command and palette lookup errors visible without ending the interface.
- Preserve editor key ownership while editing pending messages. Accept bracketed paste and Unicode backspace in palette, login and approval inputs, and recognize supported terminal key encodings. Block Alt+Enter command submission while clipboard reading is pending. Ask before palette actions replace a nonempty draft, defaulting to keeping it.

- Keep full pasted text when saving drafts, switching sessions, attaching images or submitting with Alt+Enter. Folded paste markers remain display-only. Share terminal-sequence cleanup across the main editor, editing panels and single-line settings inputs.

- Stop a turn cleanly when Esc interrupts an in-progress automatic or overflow compaction. Do not record a false no-progress decision, apply a late summary, or dispatch another model request after cancellation.

- Exclude requests that introduce an image from the text-only token-drift check. Later requests still use measured usage as their baseline.

- Label message indexes in the context workbench as positions in the next request. A reply produced after the last request is no longer described as already sent.

- Include the relay configuration example referenced by both READMEs in the installable package.

- Save the resolved setup in one-shot sessions before their first request. Opening those sessions in the TUI now restores the same model, effort and tools without asking users to review missing settings; older sessions still require review.

- Show recorded HTTP request bodies as available in the inspector summary without loading their full text until the wire section opens.

- Compare context size immediately before and after each compaction in `checkup`; later tool results no longer turn a successful reduction into a false failure.

- Do not follow directory symlinks during file searches; a cyclic link no longer turns valid matches into a search error.

- Save the full scanned `glob` match list when more than 500 paths match, and include its Recording path beside the bounded model preview.

- Tell the agent how to recover shortened `read` lines. Avoid suggesting a next-line offset when the displayed line itself is incomplete; point to the saved original text when available.

- Save long redacted MCP protocol messages as Recording attachments, and keep relative references valid when a session is forked. The event inspector shows the current session's full-body path.

- Include the recorded raw-result path when an MCP tool result is shortened for the model. Keep the preview on a Unicode boundary and label an incomplete recording as a prefix.

- Mark byte-limited `fetch` downloads as incomplete and show the captured-prefix path when available. Show the recorded body path when long lines or page results are shortened; clarify that `offset` only pages through downloaded content.

- Keep one-line tool results within the displayed byte budget, preserving complete UTF-8 characters. Remove the unused two-ended truncation policy and its test.

- Make `edit` require a unique exact match instead of silently changing punctuation or whitespace through fuzzy fallback. Preserve untouched mixed line endings, and reject invalid UTF-8 or NUL-containing files before rewriting them.

- Stop telling the agent to continue after the final page of a read or fetch result. Reject offsets beyond the end instead of returning an empty page. Apply the read output budget to directory listings while recording the full listing. Mark built-in grep/glob results incomplete when their file scan reaches its cap, and avoid directory symlink loops.

- Bound failed-session write backlog at 64 MiB before starting more work. Stop the active turn at the limit, mark uncertain tool results, and resume only after saving recovers and the user starts new work. Inputs arriving while a turn is stopping stay paused for manual continuation.

- Keep MCP connections in the pool when cleanup fails, and retry them during session shutdown. Initial setup failures now close the connection pool before exit and report both startup and cleanup errors.

- Stop bash and stdio MCP process trees on cancellation or close where the OS permits it. Report cleanup failure and possible surviving children instead of claiming they stopped. Do not start a bash command when its signal was already aborted.
- Save and release a one-shot session when runtime setup fails.
- Restrict Vitest discovery to `tests/` so acceptance-task files are not mistaken for project tests.

- Show recorded step-limit stops after session restore without a duplicate live notice. Keep retry notices inside their request so they appear before the final error.
- Show request input, measured usage, cache, latency, and stop reason across two lines in narrow inspector windows instead of truncating the outcome.
- Keep later tool results when a dropped earlier call used the same call ID. Context projection now associates each result with its own call instead of removing every matching ID.

- Describe both clipboard content and pasted image paths as a paste while input is being prepared.

- Find a safe compaction boundary without repeatedly copying the history tail. Share session-log release handling across completed switches and abandoned candidates.

- Keep one writer per session, release ownership on session handoff and clean shutdown, and reject active-session pruning. Read-only history remains available.
- Save configuration and credentials under a file lock with atomic replacement. Apply changes to the latest file so separate processes do not overwrite unrelated settings.
- Separate live requests with numbered headings. Keep the last reported cache hit rate visible in narrow terminals, distinguish missing usage from zero hits, and prioritize saving-retry controls.

- Cancel provider retry waits immediately and check cancellation before each attempt. Compose request and turn cancellation with native signals so long turns do not accumulate abort listeners.
- Point authentication, model, context-editing and error-inspection hints to the current command tree.

- Keep child-session inspection read-only and check action availability when executing. Reopening the inspector returns to the main session; child context no longer borrows the parent's tools or prefix comparison.
- Keep selected context actions visible in short terminals and page their full details. Track actions by identity when available options change. Hide retry when no reply exists, distinguish unknown results from manual edits, and explain that edited context is used by the next message.
- Offer context editing for recovered tool calls with unknown results. Preserve their original records and unknown status; stop claiming that edits necessarily reduce cache hits.
- Fork sessions from the active recording so buffered bodies remain available during source saving failures. Reopened forks retain their own events and bodies.
- Inherit the parent's current system prompt when starting child tasks. Apply explicit child-type overrides after inherited history, and preserve child prompts when resuming.
- Recalculate context size after edits or exclusions instead of reusing stale API usage. Resume measured usage after the next response; retain historical usage and costs.
- Build compaction input from the current context before selecting older messages. Honor later edits and exclusions, carry forward previous summaries and recovered tool results, and measure compression against effective content.
- Keep editing shortcuts inside the text panel. Connect Ctrl+V / Alt+V to clipboard text, wait before applying, and discard late results after the panel closes. Preserve drafts on clipboard errors and show a text-only notice for images.
- Parse skill metadata with the `yaml` library, including quoted names and multiline descriptions. Skip invalid skills individually and show their path and error in the session or CLI.

- Apply the selected preservation policy to manual `/compact`, matching automatic compaction. Original history and the retained message tail remain intact.
- Reject summaries that end at an output limit, request tools or are interrupted. Keep the existing context and show the failure instead of applying an incomplete summary.

- Show reported cache hit rates and token-share bars separately from unchanged message prefixes. Mark additions and changed tails in request input, compare recorded tool definitions, and add practical examples to setup details.

- Separate highlighted choices, current values and saved defaults in setup. Keep choice details and selection when returning, label inferred value matches accurately, and clarify that input saving is separate from request recording.

- Keep picker selection and controls visible in long lists. Show full selected values and notes with paged details; session choices share the same component and preserve the draft on return.

- Keep compaction paths and preservation values intact when saving or restoring a setup. History rendering no longer overwrites the selected runtime configuration.

- Require Node.js 22.19 or newer to match the terminal dependency. Build and package preparation now clear old compiled files before compiling.

- Child-agent forks now copy the recorded bodies referenced by inherited events, using the same recording operation as ordinary session forks. Buffered source bytes remain readable during saving failures; failed child copies clean up their candidate files. Existing tests cover independent child history and failure cleanup.
- Separate the provider contract from the Chat Completions adapter, place shared HTTP/retry/SSE helpers with their implementations, and move model settings contracts out of TUI assembly. Session recovery uses the settings registry; UI capture and display order stay in the terminal layer. No new persistent state or compatibility exports.

- Context edit/drop notices now come from recorded events, so live sessions and restored history show the same action and current-context shortcut without duplicate command notices.
- Restored request steps now use their own event positions for summaries and comparisons. Folded tool paths are shortened as plain text, preserving clickable links in full tool rows without emitting broken terminal sequences.

- Cached context messages are now frozen so readers cannot alter later model input. Explicit context edits and compaction still produce new projections while the original history remains intact.

- Draft and queued image handoffs now copy image containers, including restored queues and queue readers. Caller mutations no longer alter pending attachments or later saved input. Existing input and queue regressions cover the isolation.

- Event history now captures independent, frozen JSON snapshots. Recording owns event framing and tail repair through its ordered retry queue, preserving valid file bytes. Inspection derives unfinished capture gaps from recorded gap events.
- Image-only drafts now submit with Alt+Enter and retain Enter priority over selected history steps. Input hints reflect the draft action.

- Resuming a log whose final JSON event is complete but lacks a newline now separates the next append through the existing recording queue. Previously the two events could concatenate and be discarded as a damaged tail on the next load. Read-only inspection leaves the file unchanged.

- Saving failures no longer block model/tool work. Retained records retry automatically; raw-buffer exhaustion leaves explicit permanent gaps. Original response/tool bodies load on expansion and unchanged layouts are reused. Internal recording events no longer crowd the transcript.
- Image paste enters a removable draft attachment, persists with pending input and survives session replay. All three built-in protocols transmit image content. Windows/Linux clipboard adapters and image-file paths are supported; native clipboard and real vision-model acceptance remain separate from local protocol tests.
- Removed environment-dependent skipped coverage: the external search adapter uses deterministic process results while filesystem fallback remains exercised. No skipped or TODO test cases remain.

- Body inspection keeps the selected block's title and expansion state visible while paging. Missing saved input is shown as a recording error alongside the reconstructed view, including plain-text inspection.

- Inspector input and response bodies use per-block disclosure: ↑↓ selects, Enter expands/collapses the selected block, and PgUp/PgDn reads. Saved input, reconstructed input, original tool output, model-facing results, and HTTP attempt states remain distinct. Focus and return-to-draft controls stay visible at 60 and 110 columns.
- Printable `?` no longer intercepts an empty draft; Keyboard shortcuts is searchable in Ctrl+K. Closing overlays uses the terminal's focus restoration. Existing input tests cover draft preservation, paste isolation, and returning to editing. The obsolete trace-reader test is removed; persisted HTTP coverage remains in the end-to-end tests.

- Disk-backed sessions record adapter inputs, HTTP attempts and received bodies, plus original tool output and model-facing results. One ordered writer handles events and session-owned bodies; critical boundaries attempt a flush and streaming flushes periodically. Failed saving continues in memory with visible gaps if the raw buffer fills. Completed attachments are checked for missing or truncated content; unfinished captures remain visible. Forking copies referenced bodies, pruning includes their byte size, and graceful shutdown reports unsaved records.
- The inspector restores recorded input independently of current tools/configuration, separates original output from later model input, and folds raw bodies by default on wide and narrow terminals. Read-only history retains its evidence path. Legacy trace reading and the duplicate runtime raw-stream cache are deleted; `--trace`, `--no-trace`, `defaults.trace` and preset `trace` are removed with explicit migration errors. No new provider dependencies or model constraints.

- Session checkup separates initial and usage-based estimates, validates cache reads against reported input, accepts explicit zero-thinking replies, and states its evidence limits. Custom request bodies participate in prefix checks; HTTP recording coverage matches actual request IDs. Runtime context shows approximate usage/window and the compaction mode. Child token counts identify last input, with log paths available in expanded details; HTML previews handle terminal hyperlinks correctly.

- Bash working directories no longer leak across sessions or child runs. Child dispatch and continuation snapshot the current model and enabled catalog, including extension overrides and MCP tools. Child resources bind to their own logs and are released after execution; nested tasks retain their immediate parent's tool subset. Built-in tool assembly now uses one options object and has no sub-agent wiring.

- Rebuilding the task tool skips existing child-session files when allocating a new sub-agent ID. Explicit child continuation records missing tool outcomes as unknown before the next model request, without automatically rerunning those tools; resumed child labels retain their own ID number.

- Fatal TUI errors retain an exit-only view with the original cause, input-saving retry and manual force exit. All fatal exits return code 70. A failure of the shutdown interface or another uncaught error triggers best-effort input saving and terminal restoration, reports failures without claiming that saving or external cancellation succeeded, and exits. Exit controls stay at the bottom of a dedicated view.

- Cancellation is still delivered when persisting pending-input state or the interrupt event throws; the saving error remains observable. Fatal TUI exits retain error code 70 on the manual-exit path, and the console labels the session-log path without claiming that saving succeeded.

- Repeated Ctrl+C no longer bypasses an in-progress shutdown. `/quit` and Ctrl+C keep a responsive exit view while cancellation and resource cleanup finish; `f` explicitly forces exit after flushing enabled input saving. Missing tool outcomes and the force-exit request are recorded. Saving failures and underlying cleanup errors stay visible, including stalled extension cleanup.

- Tool execution rechecks cancellation after approval and batch waits. Calls that have not started remain unexecuted after Esc, including buffered parallel calls.
- Esc pauses undelivered inputs. A new ordinary prompt leaves paused messages alone; explicit continuation resumes them. Failed log writes retain events in memory with an explicit unsaved status.
- Each model request captures one tool catalog for definitions and execution. MCP tool-list changes reach the next request; an in-flight response keeps the implementation it was offered.
- Session bindings own their logs and artifact directories. Extensions release subscriptions and resources; failed preparation releases candidate resources and preserves the current session and draft.
- Stopping a TUI session now unsubscribes its event renderer, so late events in the old log cannot update the stopped view. Regression coverage extends the existing history-replay scenario.

### Added

- MCP calls now distinguish unknown remote outcomes after timeout, cancellation or transport loss from explicit server errors. The agent receives uncertainty and can check actual state with existing permissions; Esc still stops the turn. Cancelled requests are blocked before dispatch, local HTTP waiting is released on settlement, and unknown outcomes do not count as confirmed repeated failures. `/session recovery` includes reasons and arguments. New sessions with MCP startup events are no longer mislabeled as resumed.
- Restoring a session records missing tool results as unknown without rerunning tools or starting a model request. `/session recovery` shows the original calls and arguments; the next interaction includes an explicit uncertainty notice with normal permissions. Recovery notices have their own event provenance and do not rewrite old request projections.
- Per-session local draft and pending-input snapshots, enabled by default with `saveInputs`. Restores wait for manual continuation; `/session inputs` supports multiline editing, removal and continuing the queue. Saving failures stay visible and prevent switching or exiting until retried or saving is disabled. Empty snapshots and session-prune sidecars are cleaned up.
- TUI session composition: new sessions inherit the current setup, resume uses the target's last setup, and forks use the selected event prefix. `/session` offers alternative sources. Missing historical settings are reviewed with provenance; unavailable components expose details, retry, adjustment and read-only history. Display preferences stay current. Historical prompts stay recorded unless another composition is explicitly selected, in which case regeneration is logged as an edit.
- Healthy unchanged MCP connections can be shared between session bindings. `defaults.mcpReconnect` or `--mcp-reconnect server1,server2` selects servers to reconnect during preparation; MCP inspection shows the connection decision. Extensions are instantiated per session and may return `dispose()` for cleanup.
- Runtime UI: fixed activity and context rows, width-aware input hints, a scrollable shortcut overlay, and complete paged approval details with persistent actions. Esc returns from history before interrupting a turn; inspector shortcuts respect active dialogs. Follow-up hints now correctly say delivery happens after the current turn.
- Test discipline is documented in AGENTS.md and the READMEs. Runtime regressions extend existing interaction scenarios; the unused SplitLine component and its test are removed, and duplicate wrapping coverage is consolidated. The visual suite now captures visible terminal buffers at 60 and 120 columns.

- Agent setup replaces the flat `/settings` table with seven composable sections, model selection, searchable settings, current values, effects, recommendations and explicit timing. `This session` and `Saved defaults` are separate scopes. Inline custom values, full explanations, recommendation restore previews, enabled/disabled tool lists, bounded scrolling and narrow-terminal layouts share the same setting registry. Presets can be saved under new names and reviewed before replacing defaults for future starts. Provider credentials and external extension code are not bundled.
- `scripts/setup-preview.ts` renders 24 real component screens at 120, 80 and 60 columns without a provider connection. Setup tests cover actual next-turn tools, scope separation, restart-only settings, empty prompt sections, live-turn rejection, failed persistence, preset round-trips and long-list navigation.

- `pnpm rehearsal`: the offline half of the real-provider plan. It runs the rounds that need no key against the local fake model over real HTTP and SSE, with real tools, real session files and real rendering, judges each round with the checkup criteria, and renders every screen to `.preview/rehearsal/index.html` for review. Reviewing those screens found three alignment bugs, each now fixed with a regression test: wide characters were padded by code unit so a Chinese preview pushed the token and share columns right; request rows in the events view hung two columns left to read as chapters and knocked every column out of line (the blank line above and the brighter colour are enough); the settings key column was one character too narrow for its longest key. Two lines also said the same thing twice: an assistant reply with only tool calls printed `» » read`, and a request row repeated the word already in its type column.
- `pnpm checkup <session.jsonl>`: after a run against a real provider, this reads the session file offline and puts what the kernel predicted before each request next to what the provider reported back (estimate, measured, gap, predicted cache ceiling, measured hits, latency, retries, where the prefix broke), then runs nine checks: the prefix invariant, whether the log rebuilds the request that was sent, estimate stability per tool set, cache hits against the prediction, compaction actually shrinking the next request, failure recovery, tool error rate, thinking carried back on tool-calling replies, and raw-stream coverage. `--json` for A/B scripts. It never touches credentials and its output carries no key, so a report can be pasted back verbatim. The plan it serves is eight rounds in the internal architecture document.
- Context workbench (Ctrl+E) replaces the composition table: one column is the next request in the order the model receives it (system prompt, tool definitions, every message, the compaction summary with its covered messages folded under it, dropped messages faint in place), each row with its tokens and a share bar, a line where the last request's cached prefix ends (it moves up and turns gold after an edit, naming the change), and a preview pane for the selected row. Enter on a message opens the numbered action menu; on the system row it lists the prompt sections and flips one for the session as an edit of event #0; on the tools row it opens `/tools`; on the summary it opens the compaction comparison. With a step selected in the ledger, Ctrl+E opens at that step; a second Ctrl+E closes. The status line's context bar is two-toned: faint for the cached prefix, gold for what is new.
- Event view rewritten: one readable line per event, the right column says what the model sees of it now, requests are chapters with Ctrl+↑↓ between them, `1`–`5` filter (all, conversation, kernel, changes, extensions), and the detail has three pages (view, json, projection).
- `/settings`: every switch on one screen in six groups, with current value, one-line meaning and source (`config`, `preset`, `flag`, `built-in`); Enter changes it (booleans flip, choices open a numbered list, numbers offer common values and "type a value"), the change applies at once where it can and is written to `defaults` in the config. Typed form `/settings key value`; Ctrl+K lists every switch. The switches are one table (`src/settings.ts`) that also generates the config template's `defaults`; a test checks the command-line parser accepts every key.
- Facts the model cannot compute are attached to the event that produced them, never to a status bar: a tool result says when the same call with the same arguments failed before in this session, and when the call took at least 30 s and more than five times this session's median for that tool (`facts` in the config switches each one); a date change is appended as one user message before the next request. The bash working directory persists across calls and the result says `[cwd is now …]` when it changed.
- `plan` tool: the model writes its own plan (steps with pending / in_progress / done / cancelled); the newest call replaces the previous one and the transcript shows it as a checklist. An open plan is restored after compaction. Optional stale-plan reminders append it after `planReminder` steps without an update, with a `decision` event; `planReminder: 0` disables this counter and is the default. `plan: false` in the config removes the tool entirely (its definition costs 170 to 250 tokens per request depending on the description level).
- Model capability data (context window, output limit, effort levels, price) now comes from the models.dev registry by default: a snapshot ships in the package (`pnpm models:update` refreshes it), a cached copy refreshes daily, and the config only holds overrides. Order: model entry in config, then models.dev, then provider-level config, then an assumed 64k. The header shows the window and its source (`1M ctx (models.dev)`, red `assumed`), the request card's limit line carries the source, `/models` and the login dialog show the effective values per row. The template no longer pre-fills windows or prices.
- Models the server lists but the config does not know are now selectable in the login dialog and `/models`: their context window, output limit, effort levels and price come from the models.dev registry (cached a day in `~/.clari/models.dev.json`), else are copied from the most similar configured model, else assumed at 64k; the row says which, and choosing one writes it into the config. Configured models whose window disagrees with the registry get a note.
- The start screen is one line; the login dialog has no intro sentence and no duplicate error line; the thesis moved to the top of `/help`.
- Alt-screen viewport by default: fixed header and status line, own scrolling, mouse wheel, select-to-copy, Ctrl+Shift+F search, Ctrl+Up/Down jumps between requests (`screen: main` keeps the terminal scrollback; `--screen`).
- Ledger: every request is a step; the newest `foldSteps` (3) stay open, older ones fold to one ledger line (stop reason, calls, tokens, cache hit rate, first line of the reply or the first call). PgUp/PgDn move a step cursor and scroll that step to the top, Enter unfolds or folds it, Esc releases; `foldSteps: 0` never folds.
- Ctrl+K command palette: fuzzy search over commands, configured models, provider logins, skills and templates.
- Desktop notification (OSC 9/777 and bell) when a turn ends or approval is needed while the terminal is unfocused (`notify: unfocused | always | off`); the terminal title follows the state.
- `/copy` copies the last reply, `/copy N` its Nth code block (OSC 52). Shift+Enter inserts a newline.
- File paths in tool calls are OSC 8 `file://` links; clicking them in the alt screen opens the file.
- The seal in the header breathes while the model works; the status line shows a context pulse (last ten requests as a tiny bar chart).
- Streaming coalesced to 30 frames per second.

### Changed

- The stale-plan reminder defaults to `planReminder: 0`; explicit existing values and open-plan recovery after compaction are preserved. The model name now joins the setting registry. Settings no longer report failed strategy changes as successful saves; failed configuration writes leave the in-memory configuration unchanged. The direct `/settings key value` command still applies and saves, with partial save failures reported explicitly.

- `AGENTS.md` (working rules for people and agents) and `HANDOVER.md` (state, module map, invariants, open work, traps) added at the repository root. Three duplicated test cases removed (help output, preset precedence, step-boundary steering) and stale test titles updated.
- Thirty-nine slash commands became fourteen, and a command with choices opens a numbered list instead of expecting a typed sub-command: `/inspect` (requests, events, context, usage, compactions, edits, prompt, tools, slots, skills, mcp, fields, sessions, raw), `/set` (approve, compaction, trigger, preservation, execution, steering, effort, toolprompts: pick the slot, then the value; the current value is on the row), `/edit` (context panel, retry, list), `/model` (the last row asks the provider), `/login`, `/tools` (Enter flips a tool on or off for the session; `tools.disable` in the config switches some off at start), `/session` (new, fork, resume, list), `/memory` (show, forget one, clear with a confirmation), `/compact`, `/copy` (picks a code block when there are any), `/stop`, `/quit`, `/help` (grouped, one screen). Typed forms such as `/set approve ask` still work for scripts. `/key` is gone: keys are entered only in the login dialog. Unknown commands point to `/help` and Ctrl+K.
- The transcript prints only the conversation and the tools. The Request and Response cards are gone from the stream: no label column, no `changed` / `params` / `messages` / `limit` rows, no usage or cost on the reply, no `opaque`, `extras` or `raw` rows (all of it stays in the inspector and the context panel). Lines start in a two-column sign column: `›` you, `»` call, `└ ✓` result, `·` thinking and notes, `≡` a folded step. A note appears only when the context changed in a way the stream would otherwise hide: `✎ N edited (#…)`, `≈ compacted`, `≈ prefix recomputed from #N`, `≈ cache 31% … expected ≤…` when the hit rate is under half of the prediction, `≈ summary request`, `≈ overflow retry`, and `? context window assumed` on the first request. Result visibility is per tool (`results` in the config): `read`, `edit`, `write`, `glob`, `grep` report the line count only, `bash` shows the last `foldLines` lines, other tools the first `foldLines`; errors always show their body. Thinking is one faint line with `(N lines · Ctrl+T)`. Prose wraps at 96 columns at most; tool output and diffs never wrap, long lines are cut with `…`. The status line shows the session cost as `≈$0.0044` (two significant digits: it is measured tokens times list price, not a bill); per-step cost left the ledger lines, which now carry the cache hit rate instead. The OSC 133 prompt mark sits on the user message, so Ctrl+Up/Down jump between prompts.
- Palette and hierarchy after a design review. Morandi palette derived in OKLCH (rules in `cli/theme.ts`): ink scale with equal lightness steps (faint text now 4.6:1), two accents only, ochre red `#c87a70` for tool actions and errors, oat gold `#c7ad82` for the brand and for what changed; green is only the diff-add foreground and ✓ is ink-coloured. One glyph family: `›` you, `»` call, `└` result, `≈` compaction, `·` note, `▸` cursor, `┆` guide, `▪` seal in the header. Markdown headings and inline code are ink (code on a band), links underline only; the context bar is a thin faint line that turns red past 70%; picker and inspector titles, cursors and section names are ink.
- Screen redesign against the conventions shared by opencode, Codex CLI, pi, gemini-cli and Claude Code. Wrapped lines keep a hanging indent (label column, guide line, marker). Tool results start folded to 5 lines (`fold`, `foldLines` in config; `--fold`; Ctrl+O toggles), the first body line carries `└`, the tail says `… +N lines · Ctrl+O`. Approval prompts are a numbered vertical list (Allow once / Allow for this session / Deny with a reason / Deny) driven by `↑↓`, `1`–`4`, the letters or Enter; Esc denies. Pickers are numbered and the selected row is bold. The working line shows elapsed seconds and `Esc to interrupt`. The status line is split: state and context bar on the left, session totals and `/help` on the right; the second header line is gone. Card titles drop to the secondary colour so gold marks only what changed; `⚙` is red like every tool mark; the `reply` label sits on the reply's first line. User messages sit on a full-width band; edit/write diffs get dark green and dark red backgrounds.
- The TUI starts without any API key. A login dialog opens on first start and via `/login`: pick the provider, paste the key (masked), it is checked against the provider's model list, saved to `~/.clari/credentials.json` (mode 0600), then pick a model (`d` also makes it the default). `/model` without arguments and `/models` are list pickers. Key lookup order: env var, credentials file, config `apiKey`. `clari once` still exits when no key is found.
- Visual suite (`scripts/visual-suite.ts`) renders six scenarios to HTML; fixes found by it: the step-limit reason is English, a finished sub-agent view no longer counts a resumed run, the status bar usage follows the compaction-aware estimate after a manual `/compact`.
- Compaction trigger is an option: `threshold` (default), `manual` (only on `/compact`), `remind` (status-bar hint past the threshold); reserve tokens configurable. `defaults.compactionTrigger`, `defaults.compactionReserve`, `--compaction-trigger`, `--compaction-reserve`, `/compaction threshold|manual|remind`.
- Internal refactor: TUI, inspector and bootstrap split into single-purpose modules; session replay is near-linear (9000 events 48 s to 3.7 s); one token estimate; coverage 83% to 90%.
- Architecture document rewritten around reading the code; decision numbers removed from code comments.
- Fixed text the model reads is English throughout: unknown tool, truncated response, interrupted call, cleared tool result placeholder and compaction summary header.
- Sub-agents: child tool calls go through the parent's approval (`subagents.approval`: `inherit` by default, `allow`, or `{ deny }` to tighten); approval prompts name the asking sub-agent. Optional step limit (`subagents.maxSteps`, per type), resume with `task(resume: "sub-N")`, type registry (`subagents.types`: description, system, tools, model, scope, maxSteps), nesting depth (`subagents.depth`). Child view header shows id, type, resumed and a four-state status. Task descriptions, scope notes, result labels and errors are English.
- Tool descriptions are one source per tool in three parts (core, guidance, rules) composed by level: `brief`, `explain` (default), `rules`. Replaces the `guided` / `terse` / `strict` tables; the old names are rejected at startup.

## [0.1.0] - 2026-09-04

First installable release: `npx github:hirovel/clari`, `clari`, `clari once`, `clari replay`, `clari sessions`.

### Kernel

- Append-only event log as the only state; messages, screen, context statistics and compaction views are projections of it.
- Providers for OpenAI chat completions, OpenAI Responses and Anthropic Messages behind one interface; shared SSE reader with stall timeout; provider metadata kept verbatim in `extras`.
- Strategy slots with runtime switching: termination, steering, approval, execution, compaction, preservation, assemble. Every switch is a `session/slot` event.
- Compaction: LLM summary, clear old tool results, or both in a pipeline; external strategy modules; per-message provenance and omissions in `composeContext`.
- Context editing as events: `context/edit` and `context/drop`; originals stay in the log; edit consequences (recomputed messages, dropped thinking blocks, cache estimate) shown on the request card.
- Sub-agents as separate event logs; parent chooses the context scope.
- Approval policy: `all` by default, `policy` with allow/deny rules and mandatory prompt outside the working directory, `ask` for every call; denials carry a reason back to the model.
- Log recovery: a half-written last line is dropped and recorded as `session/recovered`.
- One `ext/event` type for optional modules; the kernel has no MCP-specific code.

### Tools

- read (files and directories), write, edit (exact match, whitespace and quote tolerant retry, `replaceAll`), bash (timeout, output cap, spill to temp file), grep (ripgrep first, JS fallback), glob, fetch (zero-dependency HTML to markdown, private-network refusal, size and time limits, cross-host redirects reported, GitHub raw rewrite, cache, rate limit), task (sub-agents), remember (optional cross-session memory), skill.
- Tool descriptions in three selectable styles (`guided`, `terse`, `strict`), editable per tool, saved to config.
- MCP client, hand-written: stdio and Streamable HTTP, 2026-07-28 stateless protocol and legacy handshake, tools named `mcp__server__tool`, every JSON-RPC exchange logged.

### Interface

- English TUI on a label gutter: one Request card per request (what changed, parameters, system sections, tools, every message with event number and token count) and one Response card (stop reason, timing, cost, cache hit, reply, thinking, calls, results, raw).
- Context panel (Ctrl+E) with an action menu per message: view, edit, compare, restore, drop, rewind, retry, fork.
- Request inspector (Ctrl+R): summary, decisions, sent messages, tool definitions, wire JSON, received stream, written events; event view; compaction comparison; composition view.
- Commands for every slot, `/tools`, `/toolprompts`, `/mcp`, `/sessions`, `/skills`, `/memory`, `/models`, `/fields`, `/raw N`, `/fork`.
- Prompt templates, skills (`SKILL.md` from four locations), `@path` attachments, cost and cache display, error cards with classification and next step.

### Configuration

- One file, `~/.clari/config.json`: providers with per-model capability data, `defaults` for every option, named `presets`, `approval`, `toolPrompts`, `fetch`, `mcp`, `sessionsDir`. Resolution order: command line, then preset, then `defaults`, then built-in.
- Keys from the config file, from the environment variable named in `apiKeyEnv`, or via `/key` in the UI; never logged.

### Sessions

- Files under `./sessions/` (or `sessionsDir`); `--continue`, `--resume`, `/fork`; `clari sessions` lists them, `clari sessions prune --older-than 30d | --keep N` deletes with sidecar trace and MCP folders, only with `--yes`.
