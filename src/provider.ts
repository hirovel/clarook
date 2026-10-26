import type { StopReason, ToolCall, Usage } from "./events.js";
import type { Message } from "./messages.js";
import type { HttpRecorder } from "./providers/http.js";

/** 工具的对外描述(执行器在 tools.ts)。parameters 是 JSON Schema。 */
export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AssistantTurn = {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage?: Usage;
  /** 供应商返回的、不解释的元数据(响应 id、服务模型、原始停止原因等)。只给人看。 */
  extras?: Record<string, unknown>;
  /** thinking 模型的推理内容(可读文本);带工具的多轮里 DeepSeek 要求原样回传。 */
  reasoning?: string;
  /** reasoning 是模型读回去的全文,还是只给人看的摘要(正文在 opaque 里)。 */
  reasoningKind?: "full" | "summary";
  /**
   * 适配器私有回传物:必须在下一轮原样送回、内核不解释的东西。
   * Anthropic 是带签名的 thinking 块;适配器写、同一适配器读,内核只搬运。
   */
  opaque?: unknown;
};

// ---------- 强度级别 ----------

/** 统一级别。缺省不传:请求里不出现任何强度参数,各家用自己的默认。 */
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** 解析用户输入的级别名;minimal 是 OpenAI 遗留写法,归为 low。 */
export function parseEffort(s: string): EffortLevel | undefined {
  if (s === "minimal") return "low";
  return (EFFORT_LEVELS as readonly string[]).includes(s) ? (s as EffortLevel) : undefined;
}

/**
 * 模型声明了支持集合时,不支持的级别向下回退到最近的支持项;没有更低的就取最低。
 * 回退结果进入请求正文,检视器的线路分区能看到;调用方负责提示用户。
 */
export function clampEffort(level: EffortLevel, supported?: readonly EffortLevel[]): EffortLevel {
  if (!supported || supported.length === 0 || supported.includes(level)) return level;
  const idx = EFFORT_LEVELS.indexOf(level);
  for (let i = idx - 1; i >= 0; i--) {
    const l = EFFORT_LEVELS[i];
    if (l && supported.includes(l)) return l;
  }
  const lowest = [...supported].sort(
    (a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b),
  )[0];
  return lowest ?? level;
}

export type WireOptions = { effort?: EffortLevel; maxTokens?: number };

export type CompleteOptions = {
  /** 宿主提供的会话记录,独立于 UI 与调试观察回调。 */
  record?: HttpRecorder;
  /** 流式增量只进 UI 不进日志:增量拼完即最终消息,日志只记完整事件。 */
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
  signal?: AbortSignal;
  /** 每次重试前回调(循环据此记 retry 事件)。 */
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  /** 非空 SSE 行的实时诊断观察者;完整正文由 record 在解析前保存。 */
  onRaw?: (line: string) => void;
  /** 每次 HTTP 尝试前交出同一份序列化正文;不含 URL、鉴权头,不证明服务器已接收。 */
  onRequest?: (body: string) => void;
  /** 本次请求的强度级别;缺省不传。 */
  effort?: EffortLevel;
  /** 本次请求的输出上限;不修改 provider 的后续默认值。 */
  maxTokens?: number;
};

/**
 * 字段清单:这个适配器往请求里放哪些字段、从响应里读哪些、明知存在但不读哪些。
 * 静态数据,与代码同步维护;界面 /fields 与文档都从这里取,不另写一份。
 */
export type FieldTable = {
  protocol: string;
  sends: string[];
  reads: string[];
  ignores: string[];
};

export interface Provider {
  readonly model: string;
  /** 字段清单(可选但建议实现):让"到底发了什么、读了什么"一条命令可查。 */
  readonly fields?: FieldTable;
  complete(messages: Message[], tools: ToolDef[], opts?: CompleteOptions): Promise<AssistantTurn>;
  /**
   * 给定消息与工具,返回将要发出的请求正文(不含鉴权头)。纯函数,与 complete 实际发送的逐字节一致。
   * 检视器用它把"模型到底收到了什么"展示到 wire 层;不实现的 provider 只能看到内核层的消息投影。
   */
  wire?(messages: Message[], tools: ToolDef[], opts?: WireOptions): unknown;
  /**
   * 投影下标 → 线路正文里的下标:第 i 条消息落在 wire 消息数组的第几条;-1 = 不在数组里(如抽到顶层的 system)。
   * Anthropic 合并连续工具结果、Responses 把一条助手消息拆成几项,组装视图据此标每条"落在哪"。
   */
  wireMap?(messages: Message[]): number[];
  /** 向供应商查询当前可用的模型名(GET /models)。发现模型下线与新模型靠这个,不靠猜。 */
  listModels?(signal?: AbortSignal): Promise<string[]>;
}
