# Third-party notices

Clarook's summary templates in `src/compaction-presets.ts` adapt the sources below. The templates are modified: they share a task-history boundary, use Clarook's existing context projection, and omit upstream runtime mechanisms. Reference names describe the sources; they do not imply affiliation or endorsement.

## Pi

Copyright (c) 2025 Mario Zechner.

The six-section checkpoint template is adapted from `packages/coding-agent/src/core/compaction/compaction.ts` at commit `1b347794e2a630e4359f2584f4eea388145d0ddf` in [earendil-works/pi](https://github.com/earendil-works/pi). Clarook rewrites the instructions and placeholders, merges previous summaries through one prompt, and does not copy split-turn summarization.

License: MIT. See [licenses/pi-MIT.txt](licenses/pi-MIT.txt).

## OpenAI Codex

OpenAI Codex. Copyright 2025 OpenAI.

The concise handoff template is adapted from `codex-rs/prompts/templates/compact/prompt.md` at commit `398500106707f0a3217c7cf83edc2bf226cc342f` in [openai/codex](https://github.com/openai/codex). Clarook rewrites the instructions and adds its shared task-history boundary. No provider-native compaction implementation or Ratatui code is included by this adaptation.

License: Apache-2.0. See [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt).

## ZCode

Copyright 2026 Z.AI Co., Ltd.

The detailed nine-section template is adapted from `apps/zcode-cli/packages/core/src/compact/prompt.ts` at commit `3c5b227649371507ddc4eb46ac5133afe6db1cab` in [zai-org/ZCode](https://github.com/zai-org/ZCode). Clarook rewrites the instructions and placeholders, emits summary text only, and omits analysis tags, XML extraction, and continuation wrappers. The configured reference uses fixed budgets and does not reproduce ZCode's runtime.

License: Apache-2.0. See [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt). ZCode's NOTICE identifies its first-party code as Apache-2.0 and third-party components as separately licensed; this adaptation includes no such third-party components.

## OpenCode

Copyright (c) 2025 opencode.

The five-section work-state template is adapted from `packages/core/src/session/compaction.ts` at commit `148842ef7cb1bc34192b3fff57d0f9721ab9c801` in [anomalyco/opencode](https://github.com/anomalyco/opencode). Clarook rewrites the instructions and placeholders, uses its existing message stream to merge prior summaries, and does not copy tool-output pruning or context serialization.

License: MIT. See [licenses/opencode-MIT.txt](licenses/opencode-MIT.txt).
