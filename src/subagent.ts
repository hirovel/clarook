// subagent:可选装能力。内核任何模块都不引用本文件;组装者按需 import 并挂成一个工具。
// 子 agent = 同一内核的递归实例化:独立事件日志、独立会话文件,replay 与构成投影零改动可用。
import { existsSync, rmSync } from "node:fs";
import { type TSchema, Type } from "@sinclair/typebox";
import { Agent } from "./agent.js";
import { outsideCwd, ruleMatches } from "./approval.js";
import { type AgentEvent, now } from "./events.js";
import { EventLog } from "./log.js";
import {
  type ApprovePolicy,
  allowAll,
  type CompactionConfig,
  maxSteps,
  type TurnDeps,
} from "./loop.js";
import { deriveMessages } from "./messages.js";
import type { Provider } from "./provider.js";
import { errorMessage } from "./providers/errors.js";
import { recordUnresolvedCalls } from "./recovery.js";
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
  system: string;
  model: string;
};

/** 返回子日志的起始事件序列。任务简报由 task 工具统一追加在其后。 */
export type ContextScope = (parent: ParentSnapshot) => AgentEvent[];

/** 注册表条目:实现 + 给父模型看的说明(会拼进工具描述,决定模型何时选它)。 */
export type ScopeEntry = { scope: ContextScope; description: string };
export type ScopeRegistry = Record<string, ScopeEntry>;

/** 零继承:只有系统提示词。系统提示词缺省沿用父的。 */
export function taskOnly(system?: string): ContextScope {
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
 * 只继承用户说过的话:去掉工具结果与助手推理。
 * 压缩事件按下标引用历史,过滤后下标失效,一并去掉。
 */
export function userMessagesOnly(): ContextScope {
  return ({ events, system }) =>
    events
      .filter((e) => e.type === "session/start" || e.type === "user/message")
      .map((e) => (e.type === "session/start" ? { ...e, system } : { ...e }));
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
      "inherits only what the user said, without tool results or assistant steps. For subtasks that need the user's original intent but not the process.",
  },
};

// ---------- 类型注册表:子是哪一种专门的 agent,由父模型在调用时选 ----------

/**
 * 子类型:自己的系统提示词、工具子集、模型、缺省范围与步数上限。
 * 每一项都可省略,省略即沿用父的;内置的 default 类型什么都不改。
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
  /** 已备好的子日志(新建的已含起始事件;续聊的是原日志)。不给就按下面两项新建。 */
  log?: EventLog;
  startEvents?: AgentEvent[];
  sessionPath?: string;
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
  const log = req.log ?? new EventLog(req.sessionPath);
  if (!req.log) for (const e of req.startEvents ?? []) log.append(e);
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
  parent: EventLog;
  provider: Provider | (() => Provider);
  /** 每次派发装配自己的资源,结束时释放。数组适用于无状态的内核工具。 */
  tools: Tool[] | ((log: EventLog) => Promise<ChildTools>);
  runner?: SubagentRunner;
  scopes?: ScopeRegistry;
  defaultScope?: string;
  /** 类型注册表,叠在内置的 default 之上。 */
  types?: SubagentTypeRegistry;
  defaultType?: string;
  /** 类型指定了 model 时据此取 provider;不给则该类型报错回喂。 */
  providerFor?: (model: string) => Provider;
  /** 给了就要求子以符合此 schema 的 JSON 收尾,并校验后随结果返回。 */
  outputSchema?: TSchema;
  /** 嵌套深度:1(缺省)= 子没有 task 工具;2 = 子有,孙没有。 */
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
  /** 子的步数上限的全局缺省;类型可覆盖;都不给就不设上限。 */
  maxSteps?: number;
  compaction?: CompactionConfig;
  /** 子 agent 一开跑就通知:界面订阅子日志,实时显示。 */
  onChild?: (child: ChildInfo) => void;
};

export type ChildTools = {
  tools: Tool[];
  dispose(): Promise<void>;
  /** 从本轮组合创建下一层资源,不重新读取根会话的开关。 */
  fork?: (log: EventLog) => Promise<ChildTools>;
};

/** task 工具对象:描述分段,suffix 是注册表生成的类型与范围列表,任何风格都附在末尾。 */
export type TaskTool = Tool & { describe: DescriptionParts };

const DESCRIPTION: Omit<DescriptionParts, "suffix"> = {
  core:
    "Delegate a bounded subtask to a sub-agent that runs in its own context and returns only its final reply; its intermediate steps stay out of this conversation. " +
    "The reply ends with the sub-agent id and its session log path; call task again with resume set to that id to give the same sub-agent a follow-up. " +
    "A sub-agent stopped by a step limit returns its work so far and can be resumed the same way.",
  guidance:
    "Good for research, search and verification that reads a lot; not for edits that depend on decisions being made here. " +
    "The brief must state the goal, the expected output format, which tools and sources to use, and the boundary of the task; ask for large results to be written to a file and the path returned. " +
    "Read the session log when you need details. The user does not see the sub-agent's reply: summarise what matters.",
  rules:
    "NEVER delegate a lookup you can do with one read or grep call. NEVER redo work you delegated; use the result. " +
    "ALWAYS state in the brief whether the sub-agent should change files or only investigate.",
};

export function createTaskTool(opts: TaskToolOptions): TaskTool {
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
  let counter = 0;
  /** 已派出的子,按 id;结束后日志留在这里供续聊,进程结束才释放。 */
  const children = new Map<string, { log: EventLog; running: boolean }>();

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
          { description: `Which kind of sub-agent; default ${defaultType}` },
        ),
      ),
      scope: Type.Optional(
        Type.Union(
          scopeNames.map((n) => Type.Literal(n)),
          {
            description: `How much of this conversation the sub-agent sees; default ${defaultScope}`,
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
      const typeName = args.type ?? defaultType;
      const type = types[typeName];
      if (!type)
        throw new Error(`Unknown sub-agent type "${typeName}"; one of: ${typeNames.join(", ")}`);
      const scopeName = args.scope ?? type.scope ?? defaultScope;
      const entry = scopes[scopeName];
      if (!entry) throw new Error(`Unknown scope "${scopeName}"; one of: ${scopeNames.join(", ")}`);
      let provider = typeof opts.provider === "function" ? opts.provider() : opts.provider;
      if (type.model) {
        if (!opts.providerFor && type.model !== provider.model)
          throw new Error(
            `Sub-agent type "${typeName}" asks for model ${type.model}, but no provider lookup is configured.`,
          );
        if (opts.providerFor) provider = opts.providerFor(type.model);
      }
      const inherited = parentSlots() ?? {};
      const compaction = opts.compaction && { ...opts.compaction };
      const limit = type.maxSteps ?? opts.maxSteps;
      const slots: NonNullable<TurnDeps["slots"]> = {
        ...inherited,
        approve: childApprove(opts.approval, inherited.approve, cwd),
        ...(limit !== undefined && { termination: maxSteps(limit) }),
      };

      const parentPath = opts.parent.path;
      const pathFor = (id: string) =>
        parentPath ? `${parentPath.replace(/\.jsonl$/, "")}-${id}.jsonl` : undefined;

      // 新建或续聊:续聊沿用原日志(内存里的,或从父会话路径重新打开)。
      let id: string;
      let log: EventLog;
      let resumed = false;
      if (args.resume) {
        id = args.resume;
        const known = children.get(id);
        if (known?.running)
          throw new Error(`Sub-agent ${id} is still running; wait for its result.`);
        if (known) log = known.log;
        else {
          const path = pathFor(id);
          if (!/^sub-\d+$/.test(id) || !path || !existsSync(path)) {
            throw new Error(
              `Unknown sub-agent id "${id}". Ids come from earlier task results in this session.`,
            );
          }
          log = EventLog.load(path, { attach: true });
        }
        resumed = true;
      } else {
        // 会话恢复会重建工具实例,内存计数不能覆盖已经存在的子日志。
        let path: string | undefined;
        do {
          counter += 1;
          id = `sub-${counter}`;
          path = pathFor(id);
        } while (children.has(id) || (path && existsSync(path)));
        const parentSnapshot: ParentSnapshot = {
          events: opts.parent.events,
          system:
            deriveMessages(opts.parent.events).find((m) => m.role === "system")?.content ?? "",
          model: provider.model,
        };
        const start = entry.scope(parentSnapshot);
        log = new EventLog(path);
        try {
          log.recording?.copyAttachments(start, opts.parent.recording);
          for (const e of start) log.append(e);
          // 显式覆盖在继承之后生效,避免继承的旧编辑再次改写它;续聊不重置子会话。
          const systemTarget = start.findIndex((e) => e.type === "session/start");
          if (type.system !== undefined && systemTarget >= 0)
            log.append({
              type: "context/edit",
              at: now(),
              target: systemTarget,
              field: "system",
              value: type.system,
            });
        } catch (error) {
          log.recording?.dispose();
          if (path) rmSync(path, { force: true });
          if (log.recording) rmSync(log.recording.directory, { recursive: true, force: true });
          throw error;
        }
      }

      const lastModel = [...log.events]
        .reverse()
        .find((e) => e.type === "session/start" || e.type === "session/model");
      if (lastModel && "model" in lastModel && lastModel.model !== provider.model)
        log.append({ type: "session/model", at: now(), model: provider.model });

      const task = opts.outputSchema
        ? `${args.task}\n\nWhen done, end with a \`\`\`json code block holding a result that matches this JSON Schema:\n${JSON.stringify(opts.outputSchema)}`
        : args.task;

      // 续聊与主会话恢复采用同一事实:缺少结果不等于未执行,不自动重跑。
      if (resumed) recordUnresolvedCalls(log);
      const info: ChildInfo = {
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
      const record = { log, running: true };
      children.set(id, record);
      let res: SubagentResult;
      try {
        const resources = Array.isArray(opts.tools)
          ? { tools: opts.tools, dispose: async () => {}, fork: undefined }
          : await opts.tools(log);
        try {
          let childTools = resources.tools.filter(
            (t) => t.name !== "task" && (!type.tools || type.tools.includes(t.name)),
          );
          if (level < depth && (!type.tools || type.tools.includes("task"))) {
            const { onChild: _drop, ...rest } = opts;
            const allowed = new Set(childTools.map((t) => t.name));
            const factory = resources.fork ?? opts.tools;
            childTools = [
              ...childTools,
              createTaskTool({
                ...rest,
                parent: log,
                provider,
                slots,
                level: level + 1,
                tools:
                  typeof factory === "function"
                    ? async (nestedLog) => {
                        const nested = await factory(nestedLog);
                        return {
                          ...nested,
                          tools: nested.tools.filter((t) => allowed.has(t.name)),
                        };
                      }
                    : childTools,
              }),
            ];
          }
          res = await runner({
            task,
            log,
            provider,
            tools: childTools,
            signal: ctx.signal,
            agent: id,
            slots,
            ...(opts.onChild && { onLog: () => opts.onChild?.(info) }),
            ...(compaction && { compaction }),
          });
        } catch (error) {
          try {
            await resources.dispose();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Sub-agent failed and cleanup failed: ${errorMessage(error)}; ${errorMessage(cleanupError)}`,
            );
          }
          throw error;
        }
        await resources.dispose();
      } catch (err) {
        record.running = false;
        info.state = { status: "partial", reason: errorMessage(err) };
        throw err;
      }
      record.running = false;
      info.state = { status: res.status, ...(res.reason && { reason: res.reason }) };

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
