// subagent:可选装能力。内核任何模块都不引用本文件;组装者按需 import 并挂成一个工具。
// 子 agent = 同一内核的递归实例化:独立事件日志、独立会话文件,replay 与构成投影零改动可用。
import { existsSync } from "node:fs";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Agent } from "./agent.js";
import { outsideCwd, ruleMatches } from "./approval.js";
import { changeContext } from "./context-edit.js";
import { type AgentEvent, now } from "./events.js";
import { EventLog } from "./log.js";
import {
  type ApprovePolicy,
  allowAll,
  type CompactionConfig,
  maxSteps,
  type TurnDeps,
} from "./loop.js";
import { editState } from "./messages.js";
import type { Provider } from "./provider.js";
import { errorMessage } from "./providers/errors.js";
import { recordUnresolvedCalls } from "./recovery.js";
import { type SystemPrompt, systemAt } from "./system-prompt.js";
import type { AfterToolCall, BeforeToolCall } from "./tool-execution.js";
import {
  composeDescription,
  type DescriptionParts,
  defineTool,
  type Tool,
  validateArgs,
} from "./tools.js";

// ---------- 上下文范围槽:子启动时看到父的什么,由父模型在调用时选 ----------

export type ParentSnapshot = {
  events: readonly AgentEvent[];
  system: SystemPrompt;
  model: string;
};

/** 返回子日志的起始事件序列。任务简报由 task 工具统一追加在其后。 */
export type ContextScope = (parent: ParentSnapshot) => AgentEvent[];

/** 注册表条目:实现 + 给父模型看的说明(会拼进工具描述,决定模型何时选它)。 */
export type ScopeEntry = { scope: ContextScope; description: string };
export type ScopeRegistry = Record<string, ScopeEntry>;

/** 零继承:只有系统提示词。系统提示词缺省沿用父的。 */
export function taskOnly(system?: SystemPrompt): ContextScope {
  return (parent) => [
    { type: "session/start", at: now(), model: parent.model, system: system ?? parent.system },
  ];
}

/**
 * 完整继承:复制父日志到干净截点 —— 发起本次派活的那条 assistant 消息之前。
 * 那条消息带着尚未应答的工具调用,进了子历史就是非法序列;它之前的内容即父此刻的完整所见。
 * 复制事件而非消息,子日志因此自洽、可回放。
 */
export function fork(): ContextScope {
  return ({ events }) => {
    let cut = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "assistant/message") {
        cut = i;
        break;
      }
    }
    return events.slice(0, cut).map((e) => ({ ...e }));
  };
}

/**
 * 继承原用户消息范围,包括已被压缩覆盖的早期要求,应用与父投影相同的最新编辑和排除。
 * 压缩与编辑引用原日志下标,不复制进已过滤的子日志。
 */
export function userMessagesOnly(): ContextScope {
  return ({ events, system }) => {
    const { edits, dropped } = editState(events);
    const inherited: AgentEvent[] = [];
    for (const [index, event] of events.entries()) {
      if (event.type === "session/start") inherited.push({ ...event, system });
      else if (event.type === "user/message" && !dropped.has(index))
        inherited.push({ ...event, text: edits.get(index)?.content ?? event.text });
    }
    return inherited;
  };
}

export const DEFAULT_SCOPES: ScopeRegistry = {
  taskOnly: {
    scope: taskOnly(),
    description:
      "a fresh context with only the system prompt and your brief. For self-contained subtasks with a clear boundary.",
  },
  fork: {
    scope: fork(),
    description:
      "inherits this whole conversation so far. For subtasks that cannot be understood without the background; costs about as much as this session.",
  },
  userMessagesOnly: {
    scope: userMessagesOnly(),
    description:
      "inherits all prior user messages, including compacted history, with current edits and exclusions applied. Omits tool results and assistant steps. For subtasks that need the user's requirements without the process.",
  },
};

// ---------- 类型注册表:子是哪一种专门的 agent,由父模型在调用时选 ----------

/**
 * 子类型:首次派发时解析自己的系统提示词、工具子集、模型、缺省范围与步数上限。
 * 每一项都可省略,省略即沿用父的;续聊取首次实际约束,不重新套注册表。
 */
export type SubagentType = {
  /** 给父模型看的说明:什么任务该派给这一类。 */
  description: string;
  /** 替换系统提示词;不给就沿用范围槽给出的(通常是父的)。 */
  system?: string;
  /** 工具子集(按名);不给就是父的全部工具。 */
  tools?: string[];
  /** 模型名;不给就用父的。需要组装者提供 providerFor。 */
  model?: string;
  /** 缺省范围;父模型调用时传 scope 可覆盖。 */
  scope?: string;
  /** 步数上限;不给就用全局的 maxSteps,再不给就不设上限。 */
  maxSteps?: number;
};
export type SubagentTypeRegistry = Record<string, SubagentType>;

export const DEFAULT_TYPES: SubagentTypeRegistry = {
  default: {
    description:
      "the same system prompt, tools and model as this session. Use when no specialised type fits.",
  },
};

// ---------- 审批:子的工具调用怎么过审 ----------

/**
 * inherit(缺省)= 沿用父此刻的审批实现,弹窗标明是哪个子在问;
 * allow = 子不问;规则对象 = 在父的基础上再收紧:命中 deny 直接拒,其余交给父的审批。
 */
export type SubagentApproval = "inherit" | "allow" | { deny: string[]; outsideCwd?: "deny" };

export function childApprove(
  policy: SubagentApproval | undefined,
  parent: ApprovePolicy | undefined,
  cwd: string,
): ApprovePolicy {
  if (policy === "allow") return allowAll;
  const base = parent ?? allowAll;
  if (policy === undefined || policy === "inherit") return base;
  return async (call, origin, signal) => {
    for (const r of policy.deny) {
      if (ruleMatches(r, call, cwd)) {
        return { allowed: false, reason: `sub-agent policy: deny rule ${r}` };
      }
    }
    if (policy.outsideCwd === "deny" && outsideCwd(call, cwd)) {
      return { allowed: false, reason: "sub-agent policy: path outside the working directory" };
    }
    return base(call, origin, signal);
  };
}

// ---------- 运行方式槽:子怎么跑 ----------

export type SubagentRequest = {
  task: string;
  /** 调用方准备并持有的子日志;runner只借用,不创建或释放。 */
  log: EventLog;
  provider: Provider;
  tools: Tool[];
  signal: AbortSignal;
  slots?: TurnDeps["slots"];
  compaction?: CompactionConfig;
  /** 子的名字(审批提示与日志显示用)。 */
  agent?: string;
  /** 子日志一创建就交出去(界面据此实时订阅)。runner 实现应在开跑前调用。 */
  onLog?: (log: EventLog) => void;
};

/** 子的生命周期状态:running → completed / partial(被打断)/ stopped(终止策略叫停,可续聊)。 */
export type ChildStatus = "running" | "completed" | "partial" | "stopped";

/** 交给界面的子 agent 信息:子只是另一个数组,界面拿到日志即可订阅。 */
export type ChildInfo = {
  log: EventLog;
  /** 子的 id(sub-N),续聊与会话文件名都用它。 */
  id: string;
  task: string;
  /** 首次派发的上下文来源;续聊不重新应用范围槽。 */
  scope: string;
  type: string;
  /** 这次是续聊(同一子日志上再跑一次)。 */
  resumed: boolean;
  /** 父会话里 task 工具调用的 id,用来把子块挂到那一行下面。 */
  callId?: string;
  /** 从 1 起的序号。 */
  index: number;
  /** 运行状态,由 task 工具在结束时更新;界面按它画头部。 */
  state: { status: ChildStatus; reason?: string };
};

/** 返回契约:最终文本 + 完成状态 + 深挖句柄。所有 runner 实现必须产出同一形态。 */
export type SubagentResult = {
  text: string;
  status: "completed" | "partial" | "stopped";
  /** stopped 时终止策略给的理由。 */
  reason?: string;
  sessionPath?: string;
};

export type SubagentRunner = (req: SubagentRequest) => Promise<SubagentResult>;

/** 进程内递归实例化:子就是另一个 Agent。 */
export const inProcessRunner: SubagentRunner = async (req) => {
  const log = req.log;
  req.onLog?.(log);
  if (req.signal.aborted)
    return { text: "", status: "partial", ...(log.path && { sessionPath: log.path }) };

  const agent = new Agent({
    log,
    provider: req.provider,
    tools: req.tools,
    ...(req.slots && { slots: req.slots }),
    ...(req.compaction && { compaction: req.compaction }),
    ...(req.agent && { agent: req.agent }),
  });
  const onAbort = () => agent.interrupt();
  req.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = await agent.prompt(req.task);
    const text = lastAssistantText(log.events);
    const path = log.path ? { sessionPath: log.path } : {};
    if (outcome === "idle") return { text, status: "completed", ...path };
    if (outcome === "aborted") return { text, status: "partial", ...path };
    return { text, status: "stopped", reason: outcome.stopped, ...path };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
};

function lastAssistantText(events: readonly AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "assistant/message" && e.text.trim()) return e.text.trim();
  }
  return "";
}

// ---------- task 工具:把上面的槽组装成一个模型可调用的能力 ----------

export type TaskToolOptions = {
  provider: Provider | (() => Provider);
  /** 可重新解析的实际模型定位符;多供应商宿主须提供 provider/model,不能只给裸模型名。 */
  modelLocator?: string | (() => string);
  /** 每次派发装配自己的资源,结束时释放。数组适用于无状态的内核工具。 */
  tools: Tool[] | ((log: EventLog) => Promise<ChildTools>);
  runner?: SubagentRunner;
  scopes?: ScopeRegistry;
  defaultScope?: string;
  /** 类型注册表,叠在内置的 default 之上。 */
  types?: SubagentTypeRegistry;
  defaultType?: string;
  /** 解析模型选择与实际定位符;续聊用首次定位符查找,不能再按裸模型名改选供应商。 */
  providerFor?: (model: string) => { provider: Provider; modelLocator: string };
  /** 给了就要求子以符合此 schema 的 JSON 收尾,并校验后随结果返回。 */
  outputSchema?: TSchema;
  /** 嵌套深度:1(缺省)= 子没有 task 工具;2 = 子有,孙没有。续聊保留首次剩余层数,当前不足则报错。 */
  depth?: number;
  /** 本工具所在层级,根会话的 task 工具是 1;嵌套时由上一层填。 */
  level?: number;
  /**
   * 父的策略槽。给函数则每次派活时取,会话中切换审批或执行策略对之后派出的子同样生效。
   * 子沿用父的执行、插话、终止(除非类型或 maxSteps 另给)与组装槽;审批按 approval 决定。
   */
  slots?: TurnDeps["slots"] | (() => TurnDeps["slots"] | undefined);
  approval?: SubagentApproval;
  /** 收紧规则里的路径按此目录解析;缺省进程工作目录。 */
  cwd?: string;
  /** 子每次运行的步数上限缺省;类型可覆盖,再沿用父的数值限制。不是累计预算。 */
  maxSteps?: number;
  compaction?: CompactionConfig;
  /** 子 agent 一开跑就通知:界面订阅子日志,实时显示。 */
  onChild?: (child: ChildInfo) => void;
  /** 观察所有层已准备好的日志;日志寿命仍归TaskSessions,不依赖界面是否展示。 */
  onLog?: (log: EventLog) => void;
};

export type ChildTools = {
  tools: Tool[];
  /** 工厂为这个子日志创建的前置函数;缺省表示该实例没有,不回退父工厂闭包。 */
  beforeToolCall?: BeforeToolCall;
  /** 后置函数与工具共用本实例资源;缺省同样不能回退父工厂闭包。 */
  afterToolCall?: AfterToolCall;
  dispose(): Promise<void>;
  /** 从本轮组合创建下一层资源,不重新读取根会话的开关。 */
  fork?: (log: EventLog) => Promise<ChildTools>;
};

/** task 工具对象:描述分段,suffix 是注册表生成的类型与范围列表,任何风格都附在末尾。 */
export type TaskTool = Tool & { describe: DescriptionParts };

const IDENTITY_SCHEMA = Type.Object({
  id: Type.String(),
  type: Type.String(),
  scope: Type.String(),
  model: Type.String({ pattern: "\\S" }),
  tools: Type.Array(Type.String(), { uniqueItems: true }),
  maxSteps: Type.Union([Type.Number(), Type.Null()]),
  remainingDepth: Type.Integer({ minimum: 0 }),
});
type ChildIdentity = Static<typeof IDENTITY_SCHEMA>;

function isIdentity(event: AgentEvent): event is Extract<AgentEvent, { type: "ext/event" }> {
  return event.type === "ext/event" && event.source === "subagent" && event.kind === "identity";
}

function childIdentity(log: EventLog, id: string): ChildIdentity {
  const own = log.events.filter((event) => isIdentity(event) && event.payload?.inherited !== true);
  const event = own[0];
  if (own.length !== 1 || !event || !isIdentity(event))
    throw new Error(
      `Sub-agent ${id} has no original execution identity; its log can be viewed, but it cannot be resumed.`,
    );
  if (
    !Value.Check(IDENTITY_SCHEMA, event.payload) ||
    event.payload.id !== id ||
    event.payload.tools.includes("task") !== event.payload.remainingDepth > 0
  )
    throw new Error(`Sub-agent ${id} has an invalid execution identity; it cannot be resumed.`);
  return event.payload;
}

const DESCRIPTION: Omit<DescriptionParts, "suffix"> = {
  core:
    "Delegate a bounded subtask to a sub-agent that runs in its own context and returns only its final reply; its intermediate steps stay out of this conversation. " +
    "The reply ends with the sub-agent id and its session log path; call task again with resume set to that id to give the same sub-agent a follow-up. " +
    "Follow-ups keep its original type, model, tool allowlist, delegation depth and per-run step limit; unavailable original resources cause an error. " +
    "A sub-agent stopped by a step limit returns its work so far and can be resumed the same way.",
  guidance:
    "Good for research, search and verification that reads a lot; not for edits that depend on decisions being made here. " +
    "The brief must state the goal, the expected output format, which tools and sources to use, and the boundary of the task; ask for large results to be written to a file and the path returned. " +
    "Read the session log when you need details. The user does not see the sub-agent's reply: summarise what matters.",
  rules:
    "NEVER delegate a lookup you can do with one read or grep call. NEVER redo work you delegated; use the result. " +
    "ALWAYS state in the brief whether the sub-agent should change files or only investigate.",
};

/** 一份会话及其子孙日志的持有者,跨工具重建复用;最终保存和释放由宿主政策决定。 */
export class TaskSessions {
  private children = new Map<string, TaskSessions>();
  private preparing = new Set<string>();
  private counter = 0;
  private running = false;

  constructor(
    readonly log: EventLog,
    private retained?: (path: string) => EventLog | undefined,
  ) {}

  logs(): EventLog[] {
    return [this.log, ...Array.from(this.children.values()).flatMap((child) => child.logs())];
  }

  tool(opts: TaskToolOptions): TaskTool {
    const sessions = this;
    const parent = this.log;
    const children = this.children;
    const preparing = this.preparing;
    const scopes = opts.scopes ?? DEFAULT_SCOPES;
    const scopeNames = Object.keys(scopes);
    const defaultScope = opts.defaultScope ?? scopeNames[0] ?? "taskOnly";
    if (!scopes[defaultScope]) throw new Error(`default scope "${defaultScope}" is not registered`);
    const types: SubagentTypeRegistry = { ...DEFAULT_TYPES, ...opts.types };
    const typeNames = Object.keys(types);
    const defaultType = opts.defaultType ?? "default";
    if (!types[defaultType]) throw new Error(`default type "${defaultType}" is not registered`);
    const runner = opts.runner ?? inProcessRunner;
    const depth = opts.depth ?? 1;
    const level = opts.level ?? 1;
    const cwd = opts.cwd ?? process.cwd();

    const list = (names: string[], reg: Record<string, { description: string }>, def: string) =>
      names
        .map((n) => `- ${n}${n === def ? " (default)" : ""}: ${reg[n]?.description ?? ""}`)
        .join("\n");
    const registryText =
      `Sub-agent types (type parameter):\n${list(typeNames, types, defaultType)}\n\n` +
      `Context scopes (scope parameter; a type may set its own default):\n${list(scopeNames, scopes, defaultScope)}`;

    const parentSlots = () => (typeof opts.slots === "function" ? opts.slots() : opts.slots);

    const describe: DescriptionParts = { ...DESCRIPTION, suffix: registryText };
    const tool = defineTool({
      name: "task",
      description: composeDescription(describe, "explain"),
      parameters: Type.Object({
        task: Type.String({
          description:
            "The brief: goal, output format, tools and sources to use, boundary of the task",
        }),
        type: Type.Optional(
          Type.Union(
            typeNames.map((n) => Type.Literal(n)),
            {
              description: `Type for a new sub-agent; default ${defaultType}. Follow-ups keep the original type and reject a different one.`,
            },
          ),
        ),
        scope: Type.Optional(
          Type.Union(
            scopeNames.map((n) => Type.Literal(n)),
            {
              description: `Context inherited by a new sub-agent; default ${defaultScope}. Ignored on resume, which keeps the existing history.`,
            },
          ),
        ),
        resume: Type.Optional(
          Type.String({
            description:
              "Id of a finished sub-agent (sub-N) to continue with this brief as a follow-up, keeping its history",
          }),
        ),
      }),
      async execute(args, ctx) {
        const parentPath = parent.path;
        const pathFor = (id: string) =>
          parentPath ? `${parentPath.replace(/\.jsonl$/, "")}-${id}.jsonl` : undefined;
        let id: string;
        let log: EventLog | undefined;
        let child: TaskSessions | undefined;
        let opened = false;
        const resumed = !!args.resume;
        if (args.resume) {
          id = args.resume;
          if (preparing.has(id))
            throw new Error(`Sub-agent ${id} is still preparing; wait for its result.`);
          const known = children.get(id);
          if (known?.running)
            throw new Error(`Sub-agent ${id} is still running; wait for its result.`);
          if (known) {
            child = known;
            log = known.log;
          } else {
            const path = pathFor(id);
            if (!/^sub-\d+$/.test(id) || !path)
              throw new Error(
                `Unknown sub-agent id "${id}". Ids come from earlier task results in this session.`,
              );
            log = sessions.retained?.(path);
            if (!log) {
              if (!existsSync(path))
                throw new Error(
                  `Unknown sub-agent id "${id}". Ids come from earlier task results in this session.`,
                );
              log = EventLog.load(path, { attach: true });
              opened = true;
            }
          }
        } else {
          // 会话恢复会重建工具实例,内存计数不能覆盖已经存在的子日志。
          let path: string | undefined;
          do {
            sessions.counter += 1;
            id = `sub-${sessions.counter}`;
            path = pathFor(id);
          } while (children.has(id) || (path && (existsSync(path) || sessions.retained?.(path))));
        }

        let resources: ChildTools | undefined;
        let info: ChildInfo | undefined;
        let record: TaskSessions | undefined;
        let res: SubagentResult;
        preparing.add(id);
        try {
          if (log) {
            child ??= new TaskSessions(log, sessions.retained);
            children.set(id, child);
          }
          const identity = resumed && log ? childIdentity(log, id) : undefined;
          if (identity && args.type !== undefined && args.type !== identity.type)
            throw new Error(
              `Sub-agent ${id} was created with type "${identity.type}"; it cannot resume as "${args.type}".`,
            );
          const typeName = identity?.type ?? args.type ?? defaultType;
          const type = identity ? undefined : types[typeName];
          if (!identity && !type)
            throw new Error(
              `Unknown sub-agent type "${typeName}"; one of: ${typeNames.join(", ")}`,
            );
          const scopeName = identity?.scope ?? args.scope ?? type?.scope ?? defaultScope;
          const entry = scopes[scopeName];
          if (!identity && !entry)
            throw new Error(`Unknown scope "${scopeName}"; one of: ${scopeNames.join(", ")}`);

          let provider = typeof opts.provider === "function" ? opts.provider() : opts.provider;
          let modelLocator =
            (typeof opts.modelLocator === "function" ? opts.modelLocator() : opts.modelLocator) ??
            provider.model;
          const requestedModel = identity?.model ?? type?.model;
          if (requestedModel !== undefined) {
            if (opts.providerFor) {
              const selected = opts.providerFor(requestedModel);
              if (identity && selected.modelLocator !== requestedModel)
                throw new Error(
                  `Sub-agent ${id} requires model ${requestedModel}, but lookup returned ${selected.modelLocator}.`,
                );
              provider = selected.provider;
              modelLocator = selected.modelLocator;
            } else if (requestedModel !== modelLocator) {
              if (identity)
                throw new Error(
                  `Sub-agent ${id} requires model ${requestedModel}, but it is unavailable.`,
                );
              if (requestedModel !== provider.model)
                throw new Error(
                  `Sub-agent type "${typeName}" asks for model ${requestedModel}, but no provider lookup is configured.`,
                );
            }
          }
          if (!modelLocator.trim())
            throw new Error(`Sub-agent ${id} requires a non-empty model locator.`);
          if (!Number.isFinite(depth) || !Number.isFinite(level))
            throw new Error(`Sub-agent ${id} requires a finite delegation depth.`);
          // 递归每次递增一层;ceil 保留有限小数 depth 的原有 level < depth 行为。
          const availableDepth = Math.max(0, Math.ceil(depth - level));
          if (identity && identity.remainingDepth > availableDepth)
            throw new Error(
              `Sub-agent ${id} requires delegation depth ${identity.remainingDepth}, but only ${availableDepth} is available.`,
            );
          const inherited = parentSlots() ?? {};
          const limit = identity
            ? identity.maxSteps
            : (type?.maxSteps ?? opts.maxSteps ?? inherited.termination?.maxSteps ?? null);
          if (limit !== null && !Number.isFinite(limit))
            throw new Error(
              `Sub-agent ${id} requires a finite step limit; received ${String(limit)}.`,
            );
          const slots: NonNullable<TurnDeps["slots"]> = {
            ...inherited,
            approve: childApprove(opts.approval, inherited.approve, cwd),
            ...(limit !== null && { termination: maxSteps(limit) }),
            // 首轮无数值限制时,续聊不能从新父模型重新继承一个步数限制。
            ...(identity &&
              limit === null &&
              inherited.termination?.maxSteps !== undefined && {
                termination: () => null,
              }),
          };
          const compaction = opts.compaction && { ...opts.compaction };
          if (!log) {
            const start = (entry as ScopeEntry)
              .scope({
                events: parent.events,
                system: systemAt(parent.events) ?? "",
                model: provider.model,
              })
              .map((event) =>
                // 保留下标与上下文引用,只标记复制来的身份,不把祖先当成本子。
                isIdentity(event)
                  ? { ...event, payload: { ...event.payload, inherited: true } }
                  : event,
              );
            const path = pathFor(id);
            log = EventLog.create(start, {
              ...(path && { filePath: path }),
              ...(parent.recording && { sourceRecording: parent.recording }),
            });
            opened = true;
            child = new TaskSessions(log, sessions.retained);
            children.set(id, child);
            const systemTarget = log.events.findIndex((event) => event.type === "session/start");
            if (type?.system !== undefined && systemTarget >= 0)
              changeContext(log, {
                type: "set-system",
                target: systemTarget,
                value: type.system,
              });
          }
          const childLog = log;
          resources = Array.isArray(opts.tools)
            ? { tools: opts.tools, dispose: async () => {} }
            : await opts.tools(childLog);
          if (!Array.isArray(opts.tools)) {
            delete slots.beforeToolCall;
            delete slots.afterToolCall;
            if (resources.beforeToolCall) slots.beforeToolCall = resources.beforeToolCall;
            if (resources.afterToolCall) slots.afterToolCall = resources.afterToolCall;
          }
          const permitted = identity?.tools ?? type?.tools;
          const remainingDepth =
            identity?.remainingDepth ??
            (!permitted || permitted.includes("task") ? availableDepth : 0);
          let childTools = resources.tools.filter(
            (tool) => tool.name !== "task" && (!permitted || permitted.includes(tool.name)),
          );
          if (remainingDepth > 0) {
            const { onChild: _drop, ...rest } = opts;
            const allowed = new Set(childTools.map((tool) => tool.name));
            const factory = resources.fork ?? opts.tools;
            childTools = [
              ...childTools,
              (child as TaskSessions).tool({
                ...rest,
                provider,
                modelLocator,
                slots,
                depth: level + remainingDepth,
                level: level + 1,
                tools:
                  typeof factory === "function"
                    ? async (nestedLog) => {
                        const nested = await factory(nestedLog);
                        return {
                          ...nested,
                          tools: nested.tools.filter((tool) => allowed.has(tool.name)),
                        };
                      }
                    : childTools,
              }),
            ];
          }
          if (identity) {
            const available = new Set(childTools.map((tool) => tool.name));
            const missing = identity.tools.filter((name) => !available.has(name));
            if (missing.length)
              throw new Error(
                `Sub-agent ${id} requires unavailable tools: ${missing.join(", ")}. Restore them before resuming.`,
              );
          } else {
            log.append({
              type: "ext/event",
              at: now(),
              source: "subagent",
              kind: "identity",
              payload: {
                id,
                type: typeName,
                scope: scopeName,
                model: modelLocator,
                tools: childTools.map((tool) => tool.name),
                maxSteps: limit,
                remainingDepth,
              } satisfies ChildIdentity,
            });
          }
          const lastModel = [...log.events]
            .reverse()
            .find((event) => event.type === "session/start" || event.type === "session/model");
          if (lastModel && "model" in lastModel && lastModel.model !== provider.model)
            log.append({ type: "session/model", at: now(), model: provider.model });
          // 验证资源后才追加恢复事实、标 running 或给 runner 新简报。
          if (resumed) recordUnresolvedCalls(log);
          info = {
            log,
            id,
            task: args.task,
            scope: scopeName,
            type: typeName,
            resumed,
            index: Number(id.slice(4)),
            state: { status: "running" },
            ...(ctx.callId && { callId: ctx.callId }),
          };
          record = child as TaskSessions;
          record.running = true;
          opts.onLog?.(log);
          preparing.delete(id);
          const task = opts.outputSchema
            ? `${args.task}\n\nWhen done, end with a \`\`\`json code block holding a result that matches this JSON Schema:\n${JSON.stringify(opts.outputSchema)}`
            : args.task;
          const childInfo = info;
          res = await runner({
            task,
            log,
            provider,
            tools: childTools,
            signal: ctx.signal,
            agent: id,
            slots,
            ...(opts.onChild && { onLog: () => opts.onChild?.(childInfo) }),
            ...(compaction && { compaction }),
          });
        } catch (error) {
          const failures = [error];
          if (resources) {
            try {
              await resources.dispose();
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
          }
          if (record) record.running = false;
          try {
            if (!record && opened && log) {
              children.delete(id);
              if (resumed) log.recording?.dispose();
              else log.recording?.discard();
            }
          } catch (cleanupError) {
            failures.push(cleanupError);
          } finally {
            preparing.delete(id);
          }
          const failure =
            failures.length === 1
              ? error
              : new AggregateError(
                  failures,
                  `Sub-agent failed and cleanup failed: ${failures.map(errorMessage).join("; ")}`,
                );
          if (info) info.state = { status: "partial", reason: errorMessage(failure) };
          throw failure;
        }
        try {
          await resources?.dispose();
        } catch (error) {
          if (record) record.running = false;
          if (info) info.state = { status: "partial", reason: errorMessage(error) };
          throw error;
        }
        if (record) record.running = false;
        if (info) info.state = { status: res.status, ...(res.reason && { reason: res.reason }) };

        let out = res.text;
        let structuredError: string | undefined;
        if (opts.outputSchema) {
          const parsed = extractJson(res.text);
          const checked = parsed === undefined ? null : validateArgs(opts.outputSchema, parsed);
          if (checked?.ok) out += `\n\nStructured result:\n${JSON.stringify(checked.value)}`;
          else
            structuredError = checked
              ? checked.error
              : "the reply does not end with a JSON code block";
        }
        const where = res.sessionPath ? `; session log: ${res.sessionPath}` : "";
        if (res.status === "partial") {
          throw new Error(
            `Sub-agent ${id} was interrupted before finishing (resume: "${id}" continues it${where}). Output so far, not to be fully trusted:\n${out}`,
          );
        }
        if (res.status === "stopped") {
          out += `\n\nSub-agent ${id} stopped early: ${res.reason ?? "termination policy"}. The work may be unfinished; call task with resume: "${id}" to continue it${where}.`;
        } else {
          out += `\n\nSub-agent ${id} finished${where}. Call task with resume: "${id}" for a follow-up in the same context.`;
        }
        if (structuredError) {
          throw new Error(`${out}\n\nStructured result failed validation:\n${structuredError}`);
        }
        return out;
      },
    });
    return Object.assign(tool, { describe });
  }
}

/** 取回复中最后一个 ```json 代码块,或末尾的裸 JSON 对象。 */
function extractJson(text: string): unknown {
  const fence = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  const candidate = fence ?? text.slice(text.lastIndexOf("{"));
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
