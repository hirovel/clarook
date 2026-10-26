// TUI 的共享状态(重构块 2):createTuiApp 组装一个显式的 ctx,拆出去的模块都是接 ctx 的函数。
// 状态按关心的事分组:model(当前模型)、view(屏幕显示状态)、req(请求层记录)、approval(审批)、
// slots(策略槽)、children(子 agent)、inspector(检视器)。函数字段是组装处提供的少数动作。
import type {
  Component,
  Container,
  Editor,
  OverlayHandle,
  ScrollView,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import type { Agent } from "../src/agent.js";
import type { ApprovalConfig } from "../src/approval.js";
import type { Preset, ResultView, ToolPromptsConfig } from "../src/config.js";
import type { Price, UsageAccumulator } from "../src/cost.js";
import type { AgentEvent, Usage } from "../src/events.js";
import type { ImageInput } from "../src/images.js";
import type { EventLog } from "../src/log.js";
import type { CompactionConfig } from "../src/loop.js";
import type { Message } from "../src/messages.js";
import type { EffortLevel, Provider, ToolDef } from "../src/provider.js";
import type { Tool } from "../src/tools.js";
import type { RequestInspector } from "./inspector.js";
import type { Skill } from "./prompt.js";
import type { PromptTemplate } from "./templates.js";
import { c } from "./theme.js";
import type { TuiAppDeps } from "./tui-app.js";
import type { Block } from "./tui-block.js";
import type { ChildView, ReplyMarkdown } from "./tui-render.js";
import type { ApprovalPrompt } from "./tui-slots.js";
import type { RuntimeStatus } from "./tui-status.js";

/** 折叠时保留的工具结果行数的缺省;配置 foldLines 可改。 */
export const FOLD_HEAD = 5;
/** 上下文脉搏保留的步数。 */
export const PULSE_STEPS = 10;
/** 子 agent 尾窗保留的行数。 */
export const CHILD_TAIL = 3;
/** 引导线:子 agent 的每一行都带它,一眼分清层级;不是框线。 */
export const GUIDE = `  ${c.faint("┆")} `;

/** 子 agent 视图的三态:尾窗(缺省)→ 全部 → 仅进度。 */
export type ChildMode = "tail" | "all" | "progress";

export type ResultRecord = Pick<
  Extract<AgentEvent, { type: "tool/result" }>,
  "name" | "content" | "isError" | "durationMs" | "outcome"
>;

/** 账簿里的一步:一次请求的所有屏幕节点装在一个容器里,折起时换成一行账目。 */
export type StepView = {
  n: number;
  requestIndex: number;
  block: Container;
  /** 展开时是请求标题,折叠时是摘要;复用同一节点,不另存标题状态。 */
  summary: Block;
  folded: boolean;
  /** 用户手动展开过:之后不再自动折。 */
  pinned: boolean;
};

export type TuiInfo = TuiAppDeps["info"];

/** 显示状态:折叠/隐藏只改屏幕,不改日志;切换键重绘已有节点。 */
export type ViewState = {
  foldResults: boolean;
  /** 折叠时保留的结果行数。 */
  foldLines: number;
  /** 每个工具的结果可见度(配置 results);没写的按 head。 */
  results: Record<string, ResultView>;
  /** 上一个画出的节点是用户消息:下一步开头不再补空行。 */
  afterUser: boolean;
  /** 保持展开的最新步数;0 = 从不自动折。 */
  foldSteps: number;
  /** 账簿光标:选中的步(steps 的下标);没有就是 undefined。 */
  selectedStep: number | undefined;
  /** 上下文脉搏:最近几次请求的估算占用 / 阈值。 */
  pulse: number[];
  /** 朱印呼吸的相位(运行中每半秒进一格)。 */
  sealFrame: number;
  /** 思考缺省折成一行(首行 + 种类 + 行数),Ctrl+T 展开全文。 */
  showReasoning: boolean;
  /** 当前草稿明确作为聊天文字发送;清空输入后恢复前缀识别。 */
  shellAsText: boolean;
  childMode: ChildMode;
  /** 首屏(新会话且还没有用户消息时显示),第一条消息一到就撤。 */
  firstRun: Text | undefined;
  streaming: ReplyMarkdown | undefined;
  streamBuffer: string;
  /** 流式合帧:增量先攒着,每 33ms 落一次屏。 */
  streamTimer: ReturnType<typeof setTimeout> | undefined;
  /** 终端是否有焦点(CSI ?1004 焦点事件);通知只在失焦时发。 */
  focused: boolean;
  /** 当前回合开始的时刻;标题栏的用时从它算。 */
  turnStartedAt: number | undefined;
  reasoningView: Block | undefined;
  reasoningBuffer: string;
  /** 工作行的用时刷新计时器。 */
  loaderTimer: ReturnType<typeof setInterval> | undefined;
  resultNodes: ({ node: Block } & ResultRecord)[];
  reasoningNodes: { node: Block; text: string; kind?: "full" | "summary" }[];
  lastUsage: Usage | undefined;
};

/** 请求层记录:发出每个请求时用的 provider、预计缓存。都不进日志。 */
export type RequestState = {
  count: number;
  lastIndex: number;
  /** 启动时日志里最后一个 request 事件的下标;回放时之前的请求卡只画两行。之后的新请求都比它大。 */
  finalRequestIndex: number;
  /** 最近一次正常步(非压缩)的 request 事件下标。 */
  lastTurnIndex: number;
  lastCompactionIndex: number;
  providersAt: Map<number, Provider>;
  /** 每次请求发出前算的缓存命中上限;响应回来与实测对照。 */
  predictedAt: Map<number, number>;
  /** 上一次正常步发出的消息:变化说明的比较基线。 */
  lastSent: Message[] | undefined;
};

/** 审批:规则对象被策略实现闭包引用,/approve 改它即生效。 */
export type ApprovalState = {
  cfg: ApprovalConfig;
  mode: "all" | "ask" | "policy";
  /** 明确选择本会话放行的工具,本会话内不再问。 */
  alwaysAllow: Set<string>;
  overlay: OverlayHandle | undefined;
  prompt: ApprovalPrompt | undefined;
};

/** 策略槽的当前配置;显示说明派生,每次切换记 session/slot。 */
export type SlotState = {
  state: Record<string, string>;
  /** 工具描述风格的当前形态:风格加逐工具覆盖。 */
  toolPrompts: ToolPromptsConfig;
  /** 本会话关掉的工具(/tools、配置 tools.disable);关掉的不随请求发出。 */
  disabledTools: Set<string>;
};

/** 换会话的目标:新建、从这里分叉、恢复另一个文件。由入口实现(停掉当前界面,换日志再起)。 */
export type SessionTarget = ({ kind: "new" } | { kind: "resume"; file: string }) & {
  source?: "current" | "defaults" | "history";
};

export type TuiContext = {
  deps: TuiAppDeps;
  /** 当前实例的配置基底;技能即时修改在此提交,待重启项仍保留启动值。 */
  setupBase: Preset;
  log: EventLog;
  tools: Tool[];
  compaction: CompactionConfig;
  agent: Agent;
  tui: TUI;
  header: Block;
  /** 对话流的根容器:步容器与用户消息都挂在它上面。 */
  root: Container;
  /** 新节点现在该进哪个容器:当前步的容器,或(用户消息、回合之外)根。 */
  transcript: Container;
  /** 备用屏的滚动视图;主屏没有。 */
  scroll: ScrollView | undefined;
  steps: StepView[];
  live: Container;
  status: RuntimeStatus;
  editor: Editor;
  draftImages: ImageInput[];
  inputReading: boolean;
  templates: PromptTemplate[];
  skills: Skill[];
  model: { info: TuiInfo; effortLevels: EffortLevel[] | undefined; contextWindow: number };
  view: ViewState;
  req: RequestState;
  /** 会话累计用量与费用,render 每条事件喂一次;状态栏与 /context 读它,不重扫事件数组。 */
  usage: UsageAccumulator;
  approval: ApprovalState;
  slots: SlotState;
  children: { views: ChildView[]; slots: Map<string, Container> };
  /** 底部对话框(登录、模型选择):同一时间只有一个。 */
  dialog: {
    overlay: OverlayHandle | undefined;
    component: Component | undefined;
    open(component: Component, onClose?: () => void): void;
    close(): void;
    /** 一条命令弹出选单时叫一声,命令就此返回;由 command 设置与清除。 */
    onOpen?: (() => void) | undefined;
  };
  inspector: {
    view: RequestInspector;
    overlay: OverlayHandle | undefined;
    open(opts?: { keep?: boolean }): void;
    close(): void;
  };
  /** 往对话流追加一行说明。 */
  note(text: string): void;
  /** 折叠设置变了:按新设置重画已有的工具结果。 */
  redrawResults?: () => void;
  /** 工具开关变了:换随请求发出的工具集。 */
  applyTools?: () => void;
  /** 桌面通知(回合结束、等审批);按 notify 设置与焦点状态决定发不发。 */
  notify(text: string): void;
  updateHeader(): void;
  updateStatus(): void;
  persistSetup(): void;
  showLoader(message: string): void;
  hideLoader(): void;
  /** 自动压缩阈值(token)。 */
  threshold(): number;
  priceFor(model: string): Price | undefined;
  /** 随请求发出的工具定义。 */
  defs(): ToolDef[];
  renderReasoning(s: string, kind?: "full" | "summary"): string;
  exit(): void;
  stop(): void;
};
