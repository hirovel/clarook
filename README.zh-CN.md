# Clarook

**看清上下文，决定下一步。**

Clarook 是一个终端 AI agent，让你查看 API 来回内容、编辑上下文，并配置 agent 的工作方式。

- **看清模型看到什么。** 查看请求正文、响应、返回的思考内容和工具结果。
- **决定下一次发送什么。** 在终端里编辑或排除上下文，保留原始历史。
- **组装自己的 agent。** 选择模型、工具、技能和策略，将组合保存为预设。

![Clarook 组合设置：独立配置各个组件](assets/clarook-setup.png)

在 `/settings` 独立调整各个组件，应用于当前会话或保存为默认值。

[English](README.md) · [更新记录](CHANGELOG.md)

## 开始使用

安装 Clarook：

```sh
npm install -g clarook@latest
```

需要 Node.js 22.19+。

在项目目录启动：

```sh
clarook
```

首次启动时，选择供应商，输入 API key，再选择模型及其作用域。

输入任务，按 Enter 发送。Esc 中断当前轮，`/quit` 退出。

进入 Clarook 后，输入 `/help` 查看命令与快捷键，`/settings` 修改配置。

菜单用方向键选择、Enter 确认、Esc 返回。设置页的操作显示在列表下方，用 ←→ 选择。

运行 `clarook --help` 查看启动参数。

更新到最新发布版本，先退出 Clarook，再运行：

```sh
npm install -g clarook@latest
```

无需全局安装时，可用 `npx clarook@latest`。

[GitHub Releases](https://github.com/hirovel/clarook/releases) 也提供预构建包：`npm install -g https://github.com/hirovel/clarook/releases/latest/download/clarook.tgz`。

Clarook 启动后检查新版，显示手动更新命令。可在 `/settings checkUpdates` 的已保存默认值中关闭检查，或启动时加 `--no-check-updates`。`/help update` 查看更新说明。

## 使用 Clarook

### 查看 API 来回内容

Ctrl+R 按顺序列出每次请求。在主屏用 Shift+PgUp/PgDn 选中请求后，Ctrl+R 直接打开该请求的接收内容。查看发送的消息、工具定义、捕获的 HTTP JSON、回复、返回的思考内容和原始工具输出。在发送与接收视图中，↑↓ 选择内容块，Enter 逐块展开，PgUp/PgDn 翻页。保存的正文、重建视图和缺失记录分别标注。

接收视图提供 `edit` 替换预览和 `write` 提交正文，并标注工具结果状态。完整参数仍可查看；预览展示提交的文字，不是完整文件快照。

### 编辑上下文

Ctrl+R 查看历史请求，Ctrl+E 检查下一次请求的上下文。在内部编辑器修改系统指令、消息和工具结果，可以排除消息、恢复编辑前的原文，也可以将上下文回退到之前的步骤。原文与修改记录保留，可查看对照。

每项操作说明是影响下一次输入、立即发送请求，还是创建会话文件。发送后，在 Ctrl+R 查看捕获的请求，核对实际发出的内容。消息之间的其他运行记录折叠为日志行，选中后按 Enter 查看记录。

### 配置组合

`/settings` 分开当前会话与已保存默认值。勾选工具和自动技能范围，配置技能目录、模型思考强度和上下文策略。状态栏提供布局预览与组件开关，组合可保存为命名预设，随时加载。

技能默认手动调用：`/名称 你的要求`，也可开启自动选择。工具统一遵循会话审批规则，技能元数据不授予权限。MCP 工具与 JavaScript/TypeScript 扩展可以添加能力或替换策略。

上下文管理提供 Pi、Codex、ZCode 和 OpenCode 参考组合，新组合默认采用 Pi 参考。选定后可分别调整触发时机、近期保留量、摘要模板、输出上限和应用条件。详情展示实际提示词、摘要格式及与来源实现的差异；自定义提示词可使用 `.md` 文件。这些文本方案共用 Clarook 的压缩流程，已保存的显式设置优先。

比例压缩可在 `/settings compactionRatio` 调整：`0` 关闭，开启建议从 `0.8` 开始。上下文长度会影响信息利用，提早摘要可能改善关注度，也可能丢失细节并增加请求。现有预留量可能更早触发。仍可用 `/compact` 手动控制。

### 执行任务与恢复会话

内置文件读取、写入、编辑、命令执行、内容搜索、路径搜索和网页读取工具。Agent 持续调用工具，直到模型结束回复。全屏模式中，PgUp/PgDn 翻阅正文；Shift+PgUp/PgDn 选择请求，输入为空时按 Enter 折叠或展开。Esc 先关闭视图或返回实时位置，再中断正在运行的当前轮。`/session` 新建、恢复和分叉会话。在恢复列表输入文字，按最后一条用户消息、模型或路径搜索全部已保存会话。历史、API 正文及原始工具输出保存在本地。

用 `@路径` 附入 UTF-8 文本，含空格的路径写成 `@"path with spaces.txt"`。超过 50 KiB、二进制或非法 UTF-8 文件会提示跳过。Ctrl+V 粘贴图片，Alt+I 查看附件列表并移除图片。

### 执行自己的命令

输入 `!git status`，按 Enter 执行，命令和结果进入下一次模型上下文。`!!git status` 显示与保存两者，不加入上下文。`/shell` 准备同一个输入模式。两种范围都不会发送 API 请求。

底部显示 **Shell** 和选中的上下文范围。Shift+Tab 切换范围；空闲时 Esc 保留文字并返回聊天。键入与粘贴采用相同规则，也支持全角 `！` 和 `！！`。

命令在空闲时从项目目录运行，超时 120 秒。每条命令重新开始，`cd` 只影响该条命令。忙时命令保留在输入框。图片保留给聊天，`@路径` 原样传给 shell。不支持需要终端输入的交互程序。长输出完整保存，提供可读取路径和有限预览。

Esc 请求取消。Windows 下执行 `taskkill` 后结束本地等待，不再等待继承的输出管道关闭。已收到的输出保留；后代停止未经核实，因此显示结果未知。这不保证所有外部工作都已停止。

支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。兼容端点可参考[中转配置示例](examples/config.relay.json)。

## 开发

克隆仓库，安装依赖，从源码运行 Clarook：

```sh
git clone https://github.com/hirovel/clarook.git
cd clarook
pnpm install
pnpm tui
```

提交修改前运行：

```sh
pnpm check
```

在源码目录用真实 API 比较配置：

```sh
pnpm evaluate validate evals/tool-descriptions.json
pnpm evaluate run evals/tool-descriptions.json .preview/evaluations/run-01
```

实验文件设置模型、基线、候选、任务与重复次数。结果包含独立产物验收、会话记录、CSV 和 HTML 报告。`pnpm evaluate report <结果目录>` 不调用 API，只重建报告。每轮使用新输出目录。结论限定于测试的模型和任务，不自动采用配置。

## 许可证

[MIT](LICENSE)

改编的摘要模板保留[第三方许可声明](THIRD_PARTY_NOTICES.md)。

曾用名 Clari。
