// TUI 应用:与终端实现解耦,便于用虚拟终端离线验证。cli/tui.ts 负责配置与真实终端,本文件负责组装。
//
// pi-tui 只当渲染引擎:差分渲染、编辑器、宽度计算;视觉层全部是自有组合。
// 界面分成几个接 ctx 的模块(重构块 2):
//   tui-context   共享状态的形状
//   tui-render    事件 → 屏幕,子 agent 视图,流式增量
//   tui-commands  提交与 / 命令的分发,列表类命令
//   tui-edit      编辑上下文的命令与面板动作
//   tui-slots     策略槽切换与审批提示
// 本文件只做:建组件树、建 Agent、建 ctx、接检视器与按键、回放历史、返回 TuiApp 接口。
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  isViewportTUI,
  Key,
  matchesKey,
  ScrollView,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { Agent, type DeliverAs } from "../src/agent.js";
import type { ApprovalConfig } from "../src/approval.js";
import type { Preset, ResultView, ToolPromptsConfig } from "../src/config.js";
import { type Price, UsageAccumulator } from "../src/cost.js";
import { type AgentEvent, now } from "../src/events.js";
import { imageBytes } from "../src/images.js";
import type { EventLog } from "../src/log.js";
import { type CompactionConfig, compactionThreshold, type TurnDeps } from "../src/loop.js";
import type { EffortLevel, Provider, ToolDef } from "../src/provider.js";
import { mergeSetup } from "../src/setup.js";
import type { ChildInfo } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { DEFAULT_RESULT_VIEWS, firstRunLines, thinkingLines } from "./cards.js";
import { type ClipboardInput, imageFromPath, readClipboardInput } from "./clipboard-input.js";
import { RequestInspector, type SessionSource } from "./inspector.js";
import { fmtTok } from "./inspector-format.js";
import type { McpServerStatus } from "./mcp/bridge.js";
import type { ModelSettings } from "./model-settings.js";
import type { Skill } from "./prompt.js";
import type { CapabilitySource } from "./registry.js";
import type { SessionInputs } from "./session-inputs.js";
import type { RecordingSection, RequestRecording } from "./session-records.js";
import { recordingReader } from "./session-records.js";
import type { SessionSetup } from "./session-setup.js";
import {
  type ExitState,
  exitReview,
  PendingInputsView,
  SessionSetupReview,
  textReview,
} from "./session-view.js";
import type { PromptTemplate } from "./templates.js";
import {
  FOCUS_OFF,
  FOCUS_ON,
  notifySequence,
  openUrl,
  withFocusTracking,
} from "./terminal-extras.js";
import { c, editorTheme, G, selectedText } from "./theme.js";
import type { MemoryFiles } from "./tools/memory.js";
import { Block } from "./tui-block.js";
import { applyTools, COMMANDS, command, openLogin, openPalette, submit } from "./tui-commands.js";
import { FOLD_HEAD, type SessionTarget, type TuiContext } from "./tui-context.js";
import { contextAction, flipSection } from "./tui-edit.js";
import { brief, cleanPasteText } from "./tui-format.js";
import { ListPicker, LoginDialog } from "./tui-login.js";
import {
  attachChild,
  render,
  resultText,
  streamDelta,
  streamReasoning,
  toggleFold,
  toggleReasoning,
} from "./tui-render.js";
import { captureSessionSetup } from "./tui-settings.js";
import { shellDraft, shellInput, toggleShellScope } from "./tui-shell.js";
import { approveImpl, initialApproval, initialSlotState } from "./tui-slots.js";
import { InputHints, RuntimeStatus } from "./tui-status.js";
import { clearStepSelection, FOLD_STEPS, selectStep, toggleSelectedStep } from "./tui-steps.js";
import { TextEditor } from "./tui-text-editor.js";

export { toolCallDetail } from "./tui-format.js";
export { childEventLines } from "./tui-render.js";

export type TuiAppDeps = {
  terminal: Terminal;
  log: EventLog;
  provider: Provider;
  tools: Tool[];
  compaction: CompactionConfig;
  reserveTokens: number;
  info: {
    model: string;
    providerName: string;
    sessionFile: string;
    resumed?: boolean;
    /** 窗口与出处,头部显示;假设值标红。 */
    contextWindow?: number;
    capabilitySource?: CapabilitySource;
  };
  settings?: ModelSettings;
  /** 启动时已解析的设置快照;用于区分当前值与后来保存的默认值。 */
  startupSettings?: Preset;
  /** 日志为空时用它落 session/start;入口已经落过(bootstrap.beginSession)就不需要。 */
  systemPrompt?: string;
  onExit?: () => void;
  /** 工具结果初始是否折叠。缺省折叠;Ctrl+O 随时切换。 */
  fold?: boolean;
  /** 折叠时保留的结果行数;缺省 5。 */
  foldLines?: number;
  /** 每个工具的结果可见度;没写的按 DEFAULT_RESULT_VIEWS,再没有按 head。 */
  results?: Record<string, ResultView>;
  /** 事实附注开关;缺省全开。 */
  facts?: { repeats?: boolean; slow?: boolean; date?: boolean };
  /** 计划复述的步数;缺省 8,0 = 从不。 */
  planReminder?: number;
  /** 账簿保持展开的最新步数;缺省 3,0 = 从不自动折。 */
  foldSteps?: number;
  statusStyle?: Preset["statusStyle"];
  statusWidgets?: string[];
  showCostEstimate?: boolean;
  /** 屏幕模式:alt(缺省)备用屏,main 主屏。 */
  screen?: "alt" | "main";
  /** 桌面通知:unfocused(缺省)| always | off。 */
  notify?: "unfocused" | "always" | "off";
  recordingFor?: (
    log: EventLog,
    requestIndex: number,
    section?: RecordingSection,
  ) => RequestRecording | undefined;
  readClipboard?: () => Promise<ClipboardInput>;
  /** 初始强度级别;缺省不传。 */
  effort?: EffortLevel;
  effortLevels?: EffortLevel[];
  /** 起始模型的价格(配置里给了才有)。 */
  price?: Price;
  /**
   * 审批槽的启动形态:all(缺省)不问;ask 每个调用都问;规则对象 = policy 模式,
   * 按规则裁决,规则说 ask 的才问人。/approve 在会话中切换。
   */
  approve?: "all" | "ask" | ApprovalConfig;
  /** 跨会话记忆已打开时的两个文件,供 /memory 看与删。 */
  memory?: MemoryFiles;
  /** 启动时的压缩策略名(llm / clear / pipeline / 模块路径),/slots 显示用;缺省 llm。 */
  compactionName?: string;
  /** 策略槽实现(执行策略、扩展模块换上的槽等)。approve=ask 时界面的审批实现覆盖这里的 approve。 */
  slots?: TurnDeps["slots"];
  /** 提示词模板:/名 参数 展开成一条用户消息。 */
  templates?: PromptTemplate[];
  /** 技能:/名 参数 触发;/inspect skills 列出。 */
  skills?: Skill[];
  /** 会话目录,/fork 的新文件写到这里。 */
  sessionsDir?: string;
  /** MCP 桥接:/mcp 列状态。工具本身已在 tools 里。 */
  mcp?: { statuses(): McpServerStatus[] };
  /** 工具描述风格槽的启动形态;/toolprompts 会话中切换与逐条编辑。 */
  toolPrompts?: ToolPromptsConfig;
  /** 启动时的保留策略原值(tokens N / ratio X);缺省内置。 */
  preservationSpec?: string;
  /** 启动时没有可用的 provider(缺 key)的原因:界面先弹登录对话框。 */
  unavailable?: string;
  /** 启动时关掉的工具(配置 tools.disable)。 */
  disabledTools?: string[];
  mcpReconnect?: string[];
  onSetupChange?: (setup: SessionSetup) => void;
  readOnlyReason?: string;
  inputs?: SessionInputs;
  saveInputs?: boolean;
  /** 换会话(/session new · fork · resume):由入口实现,停掉这个界面、换日志再起一个。 */
  switchSession?: (target: SessionTarget) => void;
};

export type TuiApp = {
  setExitState(state?: ExitState): void;
  flushInputs(): void;
  draft(): string;
  setDraft(text: string): void;
  setup(): SessionSetup;
  choose(title: string, rows: { label: string; note?: string }[]): Promise<string | undefined>;
  reviewSetup(setup: SessionSetup, missing: string[]): Promise<SessionSetup | undefined>;
  showText(title: string, text: string): Promise<void>;
  tui: TUI;
  agent: Agent;
  /** 提交一条用户消息;运行中时 deliverAs 决定是步边界插话(缺省)还是等模型做完再给。 */
  submit(text: string, opts?: { deliverAs?: DeliverAs }): Promise<void>;
  command(text: string): Promise<void>;
  /** 当前文档的渲染行(带 ANSI),用于离线验证与预览。 */
  lines(width?: number): string[];
  /** 请求检视器(Ctrl+R)。检视器预览使用 inspector.lines();app.lines() 始终返回主屏文档。 */
  inspector: {
    open(): void;
    openEvents(): void;
    openCompactions(): void;
    /** 打开工作台;at = 事件下标,光标落在从它起的第一条消息上。 */
    openComposition(at?: number): void;
    close(): void;
    isOpen(): boolean;
    key(data: string): void;
    lines(width?: number): string[];
  };
  /** 子 agent 开跑时由 task 工具通知:挂到对应调用行下面并实时订阅。 */
  attachChild(child: ChildInfo): void;
  children(): ChildInfo[];
  /** 当前策略槽实现;task 工具派活时取,子沿用父此刻的审批与执行策略。 */
  slots(): TurnDeps["slots"];
  /** 正在等待回答的审批提示的渲染行;没有时为空。离线验证用(覆盖层不在 lines() 里)。 */
  approvalLines(): string[];
  /** 把按键送给正在等待的审批提示(离线验证用)。 */
  approvalInput(data: string): void;
  /** 当前对话框(登录、模型选择)的渲染行;没有时为空。 */
  dialogLines(): string[];
  dialogInput(data: string): void;
  /** 打开登录对话框(/login)。 */
  openLogin(provider?: string): void;
  toggleFold(): void;
  toggleReasoning(): void;
  /** 往对话流追加一行说明(入口层报错用)。 */
  note(text: string): void;
  stop(): void;
};

/** 头部的窗口标签:1M ctx (models.dev);假设值用朱色,提醒去配置里写。 */
function contextTag(info: TuiAppDeps["info"]): string {
  if (!info.contextWindow) return "";
  const w = fmtTok(info.contextWindow);
  const src = info.capabilitySource ?? "config";
  return src === "assumed" ? c.zhu(`${w} ctx assumed`) : c.faint(`${w} ctx (${src})`);
}

export function createTuiApp(
  deps: TuiAppDeps,
  savedInputs = deps.inputs?.read(deps.log.events),
): TuiApp {
  const { log, tools, compaction } = deps;
  let stopped = false;
  let unsubscribeLog: (() => void) | undefined;
  let cancelDialog: (() => void) | undefined;
  let exiting = false;
  // 确认独立覆盖当前视图,取消后保留编辑面板、审批与原焦点。
  let quitPrompt: { picker: ListPicker; overlay: ReturnType<TUI["showOverlay"]> } | undefined;

  // ---------- 组件树 ----------
  // 备用屏(缺省):头部与状态行固定,正文自己滚,鼠标滚轮、拖选即复制、Ctrl+Shift+F 搜索、Ctrl+↑↓ 按步跳;
  // 主屏:一切进终端回滚。两者的组件树相同,只是挂法不同。
  const screen = deps.screen ?? "alt";
  // 焦点在终端层记:引擎(备用屏)自己也吃焦点序列,不能靠输入监听。
  const terminal = withFocusTracking(deps.terminal, (focused) => {
    ctx.view.focused = focused;
  });
  const tui: TUI =
    screen === "alt"
      ? new TuiAltScreen(terminal, true, undefined, {
          mouse: true,
          openUrl,
          searchMatchStyle: (t) => c.band(t),
          searchCurrentMatchStyle: (t) => c.inverse(t),
        })
      : new TuiMainScreen(terminal);
  const header = new Block("", { truncate: true });
  const transcript = new Container();
  const live = new Container();
  const status = new RuntimeStatus(() => ctx);
  const inputHints = new InputHints(() => ctx);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const templates = deps.templates ?? [];
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        ...COMMANDS,
        ...templates
          .filter((t) => !COMMANDS.some((command) => command.name === t.name))
          .map((t) => ({ name: t.name, description: `template: ${t.description}` })),
      ],
      process.cwd(),
    ),
  );
  // 底部组件只组装一次;两种屏幕模式与离线导出复用同一顺序。
  const bottom = new Container();
  bottom.addChild(new Spacer(1));
  bottom.addChild(editor);
  bottom.addChild(status);
  bottom.addChild(inputHints);
  let scroll: ScrollView | undefined;
  if (isViewportTUI(tui)) {
    const body = new Container();
    body.addChild(transcript);
    body.addChild(live);
    const top = new Container();
    top.addChild(header);
    top.addChild(new Spacer(1));
    scroll = new ScrollView(body, { follow: "end", primary: true, overscroll: "chain" });
    tui.setLayoutRoot(
      new VStack([
        { component: top, basis: "auto" },
        { component: scroll, basis: 0, grow: 1, minSize: 1 },
        { component: bottom, basis: "auto", shrink: 1, minSize: 1 },
      ]),
    );
  } else {
    tui.addChild(header);
    tui.addChild(new Spacer(1));
    tui.addChild(transcript);
    tui.addChild(live);
    tui.addChild(bottom);
  }
  // ---------- Agent:界面是它的事件订阅者;流式增量走两个回调 ----------
  const approval = initialApproval(deps.approve);
  // 关掉的工具(配置 tools.disable、/tools)不随请求发出;全表仍在 ctx.tools 里,开关随时可翻。
  const disabledTools = new Set(deps.disabledTools ?? []);
  const agent = new Agent({
    ...(savedInputs && { pending: savedInputs.pending }),
    onPendingChange: (pending) => {
      deps.inputs?.setPending(pending);
      ctx.updateStatus();
    },
    log,
    provider: deps.provider,
    tools: () => tools.filter((t) => !disabledTools.has(t.name)),
    compaction,
    ...(deps.effort && { effort: deps.effort }),
    ...(deps.facts && { facts: deps.facts }),
    ...(deps.planReminder !== undefined && { planReminder: deps.planReminder }),
    slots: { ...deps.slots },
    onDelta: (d) => {
      if (!stopped) streamDelta(ctx, d);
    },
    onReasoning: (d) => {
      if (!stopped) streamReasoning(ctx, d);
    },
  });

  // ---------- 检视器 ----------
  const defs = (): ToolDef[] =>
    tools
      .filter((t) => !ctx.slots.disabledTools.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const readRecording = recordingReader();
  const sessions = (): SessionSource[] => [
    {
      name: "main",
      events: log.events,
      ...(log.recording && { recordingDirectory: log.recording.directory }),
      recordingFor: (i: number, section?: RecordingSection) =>
        deps.recordingFor
          ? deps.recordingFor(log, i, section)
          : readRecording(log, log.path ?? deps.info.sessionFile, i, section),
    },
    ...ctx.children.views.map((v) => ({
      name: `sub #${v.info.index} ${brief(v.info.task)}`,
      events: v.info.log.events,
      ...(v.info.log.recording && { recordingDirectory: v.info.log.recording.directory }),
      recordingFor: (i: number, section?: RecordingSection) =>
        deps.recordingFor
          ? deps.recordingFor(v.info.log, i, section)
          : v.info.log.path
            ? readRecording(v.info.log, v.info.log.path, i, section)
            : undefined,
    })),
  ];
  const inspector = new RequestInspector({
    events: () => log.events,
    sessions,
    // 恢复的会话拿不到当时的 provider 对象;模型名相同就用当前的重建线路正文,否则如实缺省。
    providerFor: (i) => {
      const known = ctx.req.providersAt.get(i);
      if (known) return known;
      const e = log.events[i];
      return e?.type === "request" && e.model === agent.provider.model ? agent.provider : undefined;
    },
    currentProvider: () => agent.provider,
    tools: defs,
    rows: () => deps.terminal.rows,
    lastSent: () => ctx.req.lastSent,
    contextWindow: () => ctx.model.contextWindow,
    running: () => agent.running,
    readOnlyReason: () => deps.readOnlyReason,
    onClose: () => ctx.inspector.close(),
    onAction: (action, row) => void contextAction(ctx, action, row),
    onSection: (name) => flipSection(ctx, name),
    onTools: () => {
      ctx.inspector.close();
      void command(ctx, "/tools");
    },
    requestRender: () => tui.requestRender(),
  });

  // ---------- ctx:模块共享的全部状态与少数动作 ----------
  const ctx: TuiContext = {
    deps,
    setupBase: structuredClone(
      deps.startupSettings ??
        mergeSetup(
          deps.settings?.settingLayers?.().defaults ?? {},
          deps.settings?.settingLayers?.().preset ?? {},
        ),
    ),
    log,
    tools,
    compaction,
    agent,
    tui,
    header,
    root: transcript,
    transcript,
    scroll,
    steps: [],
    live,
    status,
    editor,
    templates,
    skills: deps.skills ?? [],
    model: { info: deps.info, effortLevels: deps.effortLevels, contextWindow: compaction.window },
    draftImages: savedInputs?.draft.images ?? [],
    inputReading: false,
    view: {
      foldResults: deps.fold ?? true,
      foldLines: deps.foldLines ?? FOLD_HEAD,
      results: { ...DEFAULT_RESULT_VIEWS, ...deps.results },
      afterUser: false,
      foldSteps: deps.foldSteps ?? FOLD_STEPS,
      selectedStep: undefined,
      pulse: [],
      sealFrame: 0,
      showReasoning: false,
      shellAsText: false,
      childMode: "tail",
      firstRun: undefined,
      streaming: undefined,
      streamBuffer: "",
      streamTimer: undefined,
      focused: true,
      turnStartedAt: undefined,
      reasoningView: undefined,
      reasoningBuffer: "",
      loaderTimer: undefined,
      resultNodes: [],
      reasoningNodes: [],
      lastUsage: undefined,
    },
    req: {
      count: 0,
      lastIndex: -1,
      finalRequestIndex: log.events.reduce((last, e, i) => (e.type === "request" ? i : last), -1),
      lastTurnIndex: -1,
      lastCompactionIndex: -1,
      providersAt: new Map(),
      predictedAt: new Map(),
      lastSent: undefined,
    },
    usage: new UsageAccumulator((model) => ctx.priceFor(model)),
    approval,
    slots: {
      state: initialSlotState(deps, approval),
      toolPrompts: {
        style: deps.toolPrompts?.style ?? "explain",
        descriptions: { ...deps.toolPrompts?.descriptions },
      },
      disabledTools,
    },
    children: { views: [], slots: new Map() },
    dialog: {
      overlay: undefined,
      component: undefined,
      open(component, onClose) {
        ctx.dialog.close();
        cancelDialog = onClose;
        ctx.dialog.component = component;
        ctx.dialog.overlay = tui.showOverlay(component, { width: "100%", anchor: "bottom-left" });
        quitPrompt?.overlay.focus();
        tui.requestRender();
        // 命令层在等"选单开了"这个信号,好把控制权交回去。
        ctx.dialog.onOpen?.();
      },
      close() {
        const cancel = cancelDialog;
        cancelDialog = undefined;
        cancel?.();
        if (!ctx.dialog.overlay) return;
        ctx.dialog.overlay.hide();
        ctx.dialog.overlay = undefined;
        ctx.dialog.component = undefined;
        tui.requestRender();
      },
    },
    inspector: {
      view: inspector,
      overlay: undefined,
      open(opts = {}) {
        if (ctx.inspector.overlay) return;
        // keep:调用方已经定好位(如 /raw N),不回到列表。
        if (!opts.keep) inspector.reset();
        ctx.inspector.overlay = tui.showOverlay(inspector, {
          width: "100%",
          maxHeight: "100%",
          anchor: "top-left",
        });
        tui.requestRender();
      },
      close() {
        if (!ctx.inspector.overlay) return;
        ctx.inspector.overlay.hide();
        ctx.inspector.overlay = undefined;
        tui.requestRender();
      },
    },
    note(text) {
      transcript.addChild(new Block(text));
      tui.requestRender();
    },
    redrawResults() {
      for (const r of ctx.view.resultNodes) r.node.setText(resultText(ctx, r));
      tui.requestRender();
    },
    applyTools: () => applyTools(ctx),
    notify(text) {
      const mode = deps.notify ?? "unfocused";
      if (mode === "off") return;
      if (mode === "unfocused" && ctx.view.focused) return;
      deps.terminal.write(notifySequence("clarook", text));
    },
    // 朱印呼吸:模型工作时印章按四个相位缓慢明暗,两秒一息;空闲时定在最亮。
    updateHeader() {
      const { info } = ctx.model;
      const tone = c.seal[ctx.view.sealFrame % c.seal.length] ?? c.zhu;
      header.setText(
        info.providerName === "none"
          ? `${tone(G.seal)} ${c.bold(c.jin("clarook"))}  ${c.zhu("no model")}  ${c.faint(`/login to add an API key · ${info.sessionFile}`)}`
          : `${tone(G.seal)} ${c.bold(c.jin("clarook"))}  ${c.ink(info.model)}  ${[c.faint(info.providerName), contextTag(info), c.faint(info.sessionFile)].filter(Boolean).join(c.faint(" · "))}`,
      );
    },
    updateStatus,
    // 工作状态固定在输入区下方,滚回历史时仍然可见。
    showLoader(message) {
      ctx.hideLoader();
      const startedAt = Date.now();
      ctx.view.turnStartedAt = startedAt;
      status.begin(message);
      // 半秒一拍:印章进一个相位;每两拍刷一次用时与标题。
      ctx.view.loaderTimer = setInterval(() => {
        ctx.view.sealFrame += 1;
        ctx.updateHeader();
        if (ctx.view.sealFrame % 2 === 0) {
          updateTitle();
        }
        tui.requestRender();
      }, 500);
      tui.requestRender();
    },
    hideLoader() {
      if (ctx.view.loaderTimer) clearInterval(ctx.view.loaderTimer);
      ctx.view.loaderTimer = undefined;
      ctx.view.sealFrame = 0;
      ctx.updateHeader();
      status.end();
    },
    threshold: () =>
      compactionThreshold(
        ctx.model.contextWindow,
        ctx.compaction.reserveTokens,
        ctx.compaction.ratio,
      ),
    // 当前模型的价格:配置接口优先,其次启动时带来的。
    priceFor: (model) =>
      deps.settings?.priceFor?.(model) ?? (model === ctx.model.info.model ? deps.price : undefined),
    defs,
    renderReasoning: (s, kind) =>
      thinkingLines(s, kind, ctx.view.showReasoning, Math.max(20, deps.terminal.columns - 24)).join(
        "\n",
      ),
    exit:
      deps.onExit ??
      (() => {
        ctx.stop();
        process.exit(0);
      }),
    // 构造与回放只准备界面;启动成功后才允许保存所选配置。
    persistSetup() {},
    stop() {
      stopped = true;
      if (ctx.view.streamTimer) clearTimeout(ctx.view.streamTimer);
      ctx.view.streamTimer = undefined;
      closeQuitPrompt();
      try {
        deps.inputs?.flush();
        log.recording?.flush();
      } finally {
        deps.inputs?.detach();
        for (const off of recordingOffs) off();
        // 停止的界面不再消费日志;旧连接的迟到事件不能重新驱动它渲染。
        unsubscribeLog?.();
        unsubscribeLog = undefined;
        try {
          ctx.dialog.close();
          ctx.hideLoader();
          for (const v of ctx.children.views) v.dispose();
          deps.terminal.write(FOCUS_OFF);
        } finally {
          tui.stop();
        }
      }
    },
  };
  // 审批实现闭包引用 ctx,只能在 ctx 建好后装上;all 模式不装,内核缺省就是放行。
  if (approval.mode !== "all") agent.setSlot("approve", approveImpl(ctx));

  /** 终端标题跟状态:运行中带用时,空闲带模型名。 */
  function updateTitle(): void {
    const started = ctx.view.turnStartedAt;
    const title = agent.running
      ? `clarook · running ${started ? `${Math.round((Date.now() - started) / 1000)}s` : ""}`.trim()
      : `clarook · ${ctx.model.info.model}`;
    deps.terminal.setTitle(title);
  }

  let wasRunning = false;
  /** 通知和标题跟随执行状态;固定状态区自己按实际宽度投影。 */
  function updateStatus(): void {
    if (stopped) return;
    // 运行中的审批可能新开覆盖层;确认仍应位于顶层,防止看到审批却操作了退出。
    if (quitPrompt && !quitPrompt.overlay.isFocused()) quitPrompt.overlay.focus();
    ctx.persistSetup();
    // 回合结束(运行 → 空闲)时通知一次;审批提示在 askApproval 里自己通知。之后的说明行回到根上,不进最后一步。
    if (wasRunning && !agent.running) {
      ctx.notify("turn finished");
      ctx.transcript = ctx.root;
    }
    wasRunning = agent.running;
    updateTitle();
    tui.requestRender();
  }

  const recordingOffs: (() => void)[] = [];
  const watchRecording = (source: EventLog) => {
    let shownError: string | undefined;
    const off = source.recording?.subscribe(() => {
      const recording = source.recording;
      if (recording?.error && !recording.full && recording.error !== shownError)
        ctx.note(
          c.zhu(
            `Saving failed: ${recording.error}. Retrying; work continues until the buffer fills.`,
          ),
        );
      shownError = recording?.error;
      tui.requestRender();
    });
    if (off) recordingOffs.push(off);
  };
  function closeQuitPrompt(): void {
    quitPrompt?.overlay.hide();
    quitPrompt = undefined;
  }
  try {
    // 焦点事件:通知只在终端失焦时发。
    deps.terminal.write(FOCUS_ON);
    watchRecording(log);

    // ---------- 历史回放与订阅:屏幕即历史,历史与新事件长得一样 ----------
    const draw = (e: AgentEvent, index = log.events.length - 1) => {
      status.observe(e);
      render(ctx, e, index);
    };
    if (log.events.length > 0) {
      for (const [index, e] of log.events.entries()) draw(e, index);
      unsubscribeLog = log.subscribe(draw);
      if (deps.info.resumed) {
        ctx.note(
          c.soft(`· resumed: ${log.events.length} events, appending to ${deps.info.sessionFile}`),
        );
      }
    } else {
      unsubscribeLog = log.subscribe(draw);
      log.append({
        type: "session/start",
        at: now(),
        model: deps.info.model,
        system: deps.systemPrompt ?? "",
      });
    }
    if (!log.events.some((e) => e.type === "user/message" || e.type === "user/shell")) {
      // 首屏一行占位;没 key 时连这一行也不要,屏幕上只有头部与登录对话框。
      if (deps.info.providerName !== "none") {
        ctx.view.firstRun = new Text(firstRunLines().join("\n"), 1, 0);
        transcript.addChild(ctx.view.firstRun);
      }
    }
    ctx.updateHeader();
    updateStatus();

    // ---------- 输入 ----------
    editor.onSubmit = (raw) => {
      // 编辑器先清空再回调;接收成功前恢复草稿,让附图归属与失败保留走同一条路径。
      editor.setText(raw);
      const text = raw.trim();
      if (ctx.inputReading) {
        ctx.note(c.soft("Preparing paste; send after it appears."));
        return;
      }
      if (!text && !ctx.draftImages.length) return;
      editor.addToHistory(text);
      if (text.startsWith("/")) {
        if (!/^\/shell(?:\s|$)/.test(text)) editor.setText("");
        void command(ctx, text);
      } else void submit(ctx, text);
    };
    if (savedInputs) editor.setText(savedInputs.draft.text);
    deps.inputs?.bind((error) =>
      ctx.note(
        c.zhu(
          `Input saving failed: ${error.message}. Keep this session open and retry with /session inputs.`,
        ),
      ),
    );
    editor.onChange = () => {
      if (!editor.getExpandedText()) ctx.view.shellAsText = false;
      deps.inputs?.setDraft(editor.getExpandedText(), ctx.draftImages);
    };

    function askToQuit(): void {
      if (exiting || quitPrompt) return;
      const picker = new ListPicker(
        "Quit Clarook",
        [
          {
            label: "Continue using Clarook",
            note: "Return to the current view. No work is cancelled.",
            current: true,
          },
          {
            label: "Exit",
            note: [
              "Cancel active work and close Clarook. External work may continue until cancellation completes.",
              deps.inputs?.saving
                ? "Save drafts and queued messages for later."
                : "Input saving is off; unsaved input will be lost.",
            ].join("\n"),
          },
        ],
        "↑↓ choose · Enter select · Esc back",
        (row) => {
          closeQuitPrompt();
          if (row.label === "Exit") ctx.exit();
        },
        closeQuitPrompt,
        () => tui.requestRender(),
        () => deps.terminal.rows,
      );
      quitPrompt = {
        picker,
        overlay: tui.showOverlay(picker, { width: "100%", anchor: "bottom-left" }),
      };
    }

    const pasteInput = async (get: () => Promise<ClipboardInput>) => {
      if (ctx.inputReading) return;
      ctx.inputReading = true;
      tui.requestRender();
      try {
        const value = await get();
        const image = value.image ?? (value.text ? await imageFromPath(value.text) : undefined);
        if (stopped) return;
        if (image) {
          ctx.draftImages = [...ctx.draftImages, image];
          deps.inputs?.setDraft(editor.getExpandedText(), ctx.draftImages);
        } else if (value.text) {
          editor.handleInput(`\x1b[200~${cleanPasteText(value.text)}\x1b[201~`);
        } else ctx.note(c.soft("No image or text on the clipboard."));
      } catch (error) {
        if (!stopped)
          ctx.note(c.zhu(`Paste failed: ${(error as Error).message}. Draft unchanged.`));
      } finally {
        ctx.inputReading = false;
        if (!stopped) tui.requestRender();
      }
    };

    tui.addInputListener((data) => {
      if (
        !exiting &&
        !quitPrompt &&
        !ctx.inspector.overlay &&
        !approval.overlay &&
        !ctx.dialog.overlay
      ) {
        if (matchesKey(data, Key.ctrl("v")) || matchesKey(data, Key.alt("v"))) {
          void pasteInput(deps.readClipboard ?? readClipboardInput);
          return { consume: true };
        }
        if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
          const pasted = data.slice(6, -6);
          if (/\.(png|jpe?g|gif|webp)["']?\s*$/i.test(pasted.trim()) && !/[\r\n]/.test(pasted)) {
            void pasteInput(async () => ({ text: pasted }));
            return { consume: true };
          }
          return { data: `\x1b[200~${cleanPasteText(pasted)}\x1b[201~` };
        }
        if (matchesKey(data, Key.alt("i"))) {
          let selected = 0;
          ctx.dialog.open({
            invalidate() {},
            render(width) {
              const line = (s: string) => truncateToWidth(s, Math.max(1, width - 2));
              const count = Math.max(1, terminal.rows - 8);
              const start = Math.max(0, selected - count + 1);
              return [
                line(
                  ` Draft images · ${ctx.draftImages.length} attached · Enter sends from editor`,
                ),
                "",
                ...ctx.draftImages.slice(start, start + count).map((image, index) => {
                  const i = start + index;
                  const text = ` ${selected === i ? G.cursor : " "} ${i + 1}. ${image.name ?? image.mimeType} · ${imageBytes(image)} bytes`;
                  return line(selected === i ? selectedText(text) : c.ink(text));
                }),
                ...(ctx.draftImages.length ? [] : [" No images attached."]),
                "",
                " ↑↓ select · Delete remove · Esc back",
              ];
            },
            handleInput(key) {
              if (matchesKey(key, Key.escape)) ctx.dialog.close();
              else if (matchesKey(key, Key.up)) selected = Math.max(0, selected - 1);
              else if (matchesKey(key, Key.down))
                selected = Math.min(ctx.draftImages.length - 1, selected + 1);
              else if (matchesKey(key, Key.delete)) {
                ctx.draftImages = ctx.draftImages.filter((_, i) => i !== selected);
                selected = Math.max(0, Math.min(selected, ctx.draftImages.length - 1));
                deps.inputs?.setDraft(editor.getExpandedText(), ctx.draftImages);
              }
              tui.requestRender();
            },
          });
          return { consume: true };
        }
      }
      if (matchesKey(data, Key.ctrl("s"))) {
        if (!exiting && !quitPrompt && ctx.dialog.component instanceof LoginDialog) {
          ctx.dialog.component.handleInput(data);
          return { consume: true };
        }
        for (const source of [log, ...ctx.children.views.map((v) => v.info.log)])
          source.recording?.flush();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("c"))) {
        // 已开始收尾时复用宿主的幂等关闭请求,不另开确认或强退。
        if (exiting) ctx.exit();
        else askToQuit();
        return { consume: true };
      }
      if (exiting) {
        ctx.dialog.component?.handleInput?.(data);
        return { consume: true };
      }
      if (quitPrompt) {
        quitPrompt.picker.handleInput(data);
        return { consume: true };
      }
      // 编辑面板先于应用快捷键接收输入;退出和记录保存仍由上方统一处理。
      if (
        ctx.dialog.component instanceof TextEditor ||
        (ctx.dialog.component instanceof PendingInputsView && ctx.dialog.component.editingText)
      ) {
        ctx.dialog.component.handleInput(data);
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("k"))) {
        if (ctx.inspector.overlay || approval.overlay) return undefined;
        if (ctx.dialog.overlay) ctx.dialog.close();
        else openPalette(ctx);
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("r"))) {
        if (approval.overlay || ctx.dialog.overlay) return undefined;
        if (ctx.inspector.overlay) ctx.inspector.close();
        else {
          ctx.inspector.open();
          // 主屏已选请求时直接查看它的接收内容,不再让用户在列表里重复定位。
          const step = ctx.steps[ctx.view.selectedStep ?? -1];
          if (step) inspector.showRequest(step.n, 6);
          tui.requestRender();
        }
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("e"))) {
        if (approval.overlay || ctx.dialog.overlay) return undefined;
        // Ctrl+E:上下文工作台。账簿光标停在某一步时,落在那一步的消息上;再按一次关。
        if (ctx.inspector.overlay && inspector.currentMode === "composition") {
          ctx.inspector.close();
          return { consume: true };
        }
        if (!ctx.inspector.overlay) ctx.inspector.open();
        const step =
          ctx.view.selectedStep !== undefined ? ctx.steps[ctx.view.selectedStep] : undefined;
        inspector.showComposition(step ? step.requestIndex : undefined);
        tui.requestRender();
        return { consume: true };
      }
      if (ctx.inspector.overlay || approval.overlay || ctx.dialog.overlay) return undefined; // 检视器、审批提示或对话框打开时,其余按键归它们
      // 明确作为聊天的前缀文字不经过编辑器的提交前清空,否则 onChange 会重置选择。
      if (
        matchesKey(data, Key.enter) &&
        !editor.isShowingAutocomplete() &&
        ctx.view.shellAsText &&
        shellInput(editor.getExpandedText())
      ) {
        editor.onSubmit?.(editor.getExpandedText());
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab") && shellDraft(ctx)) {
        toggleShellScope(ctx);
        return { consume: true };
      }
      if (
        matchesKey(data, Key.escape) &&
        !agent.running &&
        !editor.isShowingAutocomplete() &&
        shellDraft(ctx)
      ) {
        ctx.view.shellAsText = true;
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.alt("enter"))) {
        if (ctx.inputReading) {
          ctx.note(c.soft("Preparing paste; send after it appears."));
          return { consume: true };
        }
        // 后续留言:不打断当前步,等模型不再调工具时才给它。空闲时与普通提交等价。
        const text = editor.getExpandedText().trim();
        if (!text && !ctx.draftImages.length) return { consume: true };
        editor.addToHistory(text);
        if (text.startsWith("/")) {
          if (!/^\/shell(?:\s|$)/.test(text)) editor.setText("");
          void command(ctx, text);
        } else void submit(ctx, text, { deliverAs: "followUp" });
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("o"))) {
        toggleFold(ctx);
        return { consume: true };
      }
      // 翻页归终端引擎;请求选择使用修饰键,不覆盖正文阅读或菜单翻页。
      if (matchesKey(data, "shift+pageUp") || matchesKey(data, "shift+pageDown")) {
        selectStep(ctx, matchesKey(data, "shift+pageUp") ? -1 : 1);
        return { consume: true };
      }
      if (
        matchesKey(data, Key.enter) &&
        editor.getText() === "" &&
        !ctx.draftImages.length &&
        !editor.isShowingAutocomplete() &&
        ctx.view.selectedStep !== undefined
      ) {
        toggleSelectedStep(ctx);
        return { consume: true };
      }
      if (
        matchesKey(data, Key.escape) &&
        !editor.isShowingAutocomplete() &&
        (ctx.view.selectedStep !== undefined || (scroll && !scroll.isFollowingEnd))
      ) {
        clearStepSelection(ctx);
        scroll?.scrollToEnd();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("t"))) {
        toggleReasoning(ctx);
        return { consume: true };
      }
      if (matchesKey(data, Key.escape) && agent.running && !editor.isShowingAutocomplete()) {
        agent.interrupt();
        return { consume: true };
      }
      return undefined;
    });

    tui.setFocus(editor);
    tui.start();
    // 没 key:屏幕上只留头部与对话框;原因已在头部(no model),不再另打一行。
    if (deps.unavailable) openLogin(ctx, {});
    ctx.persistSetup = () => deps.onSetupChange?.(captureSessionSetup(ctx));
    ctx.persistSetup();

    function sessionDialog<T>(
      build: (done: (value?: T) => void) => Component,
    ): Promise<T | undefined> {
      return new Promise((resolve) => {
        ctx.dialog.open(
          build((value) => {
            resolve(value);
            ctx.dialog.close();
          }),
          () => resolve(undefined),
        );
      });
    }

    return {
      tui,
      flushInputs: () => deps.inputs?.flush(),
      agent,
      draft: () => editor.getExpandedText(),
      setDraft: (text) => {
        editor.setText(text);
        tui.requestRender();
      },
      setExitState(state) {
        exiting = Boolean(state);
        if (state) {
          closeQuitPrompt();
          ctx.inspector.close();
          ctx.dialog.open(exitReview(ctx, state));
        } else ctx.dialog.close();
      },
      setup: () => captureSessionSetup(ctx),
      choose: (heading, rows) =>
        sessionDialog<string>(
          (done) =>
            new ListPicker(
              heading,
              rows,
              "↑↓ choose · Enter select · Esc back",
              (row) => done(row.label),
              () => done(),
              () => tui.requestRender(),
              () => deps.terminal.rows,
            ),
        ),
      reviewSetup: (setup, missing) =>
        sessionDialog<SessionSetup>(
          (done) =>
            new SessionSetupReview(
              setup,
              missing,
              () => deps.terminal.rows,
              done,
              () => tui.requestRender(),
            ),
        ),
      showText: (heading, text) =>
        sessionDialog<void>((done) =>
          textReview(
            heading,
            text,
            () => deps.terminal.rows,
            done,
            () => tui.requestRender(),
          ),
        ),
      submit: (text, opts) =>
        exiting
          ? Promise.reject(new Error("Session is closing; new input was not submitted."))
          : submit(ctx, text, opts),
      command: (text) =>
        exiting && text.trim() !== "/quit"
          ? Promise.reject(new Error("Session is closing; command was not run."))
          : command(ctx, text),
      // 离线验证与预览用的整份文档:两种屏幕模式都按同一顺序拼,备用屏的滚动区不经布局不出行。
      lines: (width = deps.terminal.columns) =>
        isViewportTUI(tui)
          ? [
              ...header.render(width),
              "",
              ...transcript.render(width),
              ...live.render(width),
              ...bottom.render(width),
            ]
          : tui.render(width),
      inspector: {
        open: () => ctx.inspector.open(),
        openEvents: () => {
          ctx.inspector.open();
          inspector.showEvents();
        },
        openCompactions: () => {
          ctx.inspector.open();
          inspector.showCompactions();
        },
        openComposition: (at) => {
          ctx.inspector.open();
          inspector.showComposition(at);
        },
        close: () => ctx.inspector.close(),
        isOpen: () => ctx.inspector.overlay !== undefined,
        key: (data) => inspector.handleInput(data),
        lines: (width = deps.terminal.columns) =>
          ctx.inspector.overlay ? inspector.render(width) : [],
      },
      attachChild: (child) => {
        watchRecording(child.log);
        return attachChild(ctx, child);
      },
      children: () => ctx.children.views.map((v) => v.info),
      slots: () => ctx.agent.slots,
      approvalLines: () => approval.prompt?.render(deps.terminal.columns) ?? [],
      approvalInput: (data) => approval.prompt?.handleInput(data),
      note: (text) => ctx.note(text),
      dialogLines: () =>
        (quitPrompt?.picker ?? ctx.dialog.component)?.render(deps.terminal.columns) ?? [],
      dialogInput: (data) => (quitPrompt?.picker ?? ctx.dialog.component)?.handleInput?.(data),
      openLogin: (provider) => openLogin(ctx, provider ? { provider } : {}),
      toggleFold: () => toggleFold(ctx),
      toggleReasoning: () => toggleReasoning(ctx),
      stop: () => ctx.stop(),
    };
  } catch (error) {
    try {
      ctx.stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "TUI initialization and cleanup failed");
    }
    throw error;
  }
}
