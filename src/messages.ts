import type { AgentEvent, ToolCall } from "./events.js";
import type { ImageInput } from "./images.js";
import { unresolvedCalls } from "./recovery.js";
import { directoryAt } from "./session-directory.js";
import { type SystemPrompt, systemText } from "./system-prompt.js";
import { applyToolOmissions, prepareReplay, toolReplay } from "./tool-replay.js";

/**
 * 内部消息模型:自有类型,不绑任何 provider 的 wire 格式。
 * 它只描述"模型将看到什么",翻译成 OpenAI/Anthropic 格式是适配器的事。
 */
export type Message = {
  /** 此消息之前有可见内容被丢弃;不表示正文被编辑。 */
  prefixChanged?: true;
} & (
  | { role: "system"; content: string; edited?: true }
  | { role: "user"; content: string; edited?: true; images?: ImageInput[] }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      reasoning?: string;
      reasoningKind?: "full" | "summary";
      /** 适配器私有回传物,原样透传。 */
      opaque?: unknown;
      /** 这条消息被 context/edit 改过:回传物已丢弃;适配器据此决定之后的思考块要不要丢。 */
      edited?: true;
    }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
      edited?: true;
    }
);

type EditValues = { system: SystemPrompt; text: string; reasoning: string; content: string };

/** 用户命令明确标来源;输出不是新的用户指令,也不是模型发起的工具调用。 */
export function userShellText(event: Extract<AgentEvent, { type: "user/shell" }>): string {
  return `The user ran a shell command.\nWorking directory: ${event.cwd}\nCommand:\n${event.command}\nOutput:\n${event.content}`;
}

/** 编辑状态:每个目标事件各字段的最新值,以及被丢弃的事件下标。 */
export function editState(
  events: readonly AgentEvent[],
  upTo = events.length,
): {
  edits: Map<number, Partial<EditValues>>;
  dropped: Set<number>;
} {
  const edits = new Map<number, Partial<EditValues>>();
  const dropped = new Set<number>();
  for (let k = 0; k < upTo; k++) {
    const e = events[k];
    if (!e) continue;
    if (e.type === "context/edit") {
      if (events[e.target]?.type === "session/directory") continue;
      const cur = edits.get(e.target) ?? {};
      if (e.field === "system") cur.system = e.value;
      else cur[e.field] = e.value;
      edits.set(e.target, cur);
    } else if (e.type === "context/drop") {
      if (events[e.target]?.type === "session/directory") continue;
      dropped.add(e.target);
    }
  }
  // 结果归属于最近一次同 ID 调用。丢弃旧调用时不能删掉后续轮次复用 ID 的结果。
  if ([...dropped].some((i) => events[i]?.type === "assistant/message")) {
    const owners = new Map<string, number>();
    for (let i = 0; i < upTo; i++) {
      const e = events[i];
      if (e?.type === "assistant/message") {
        for (const call of e.toolCalls) owners.set(call.id, i);
      } else if (e?.type === "tool/result" && dropped.has(owners.get(e.callId) ?? -1)) {
        dropped.add(i);
      } else if (e?.type === "tool/unresolved" && dropped.has(e.callEvent)) {
        dropped.add(i);
      }
    }
  }
  return { edits, dropped };
}

export const CLEARED_PLACEHOLDER =
  "[This tool result was cleared to save context; the original is kept in full in the session log]";

/** 从事件里汇总当前生效的压缩状态:摘要覆盖范围 + 被清除的工具结果下标。 */
export function compactionState(
  events: readonly AgentEvent[],
  upTo = events.length,
): {
  summary?: string;
  coversFrom: number;
  coversUpTo: number;
  cleared: Set<number>;
} {
  let summary: string | undefined;
  let coversFrom = 1;
  let coversUpTo = 0;
  const cleared = new Set<number>();
  for (let i = 0; i < upTo; i++) {
    const e = events[i];
    if (e?.type !== "compaction") continue;
    if (e.summary && (e.coversUpTo ?? 0) > coversUpTo) {
      summary = e.summary;
      coversUpTo = e.coversUpTo ?? 0;
      coversFrom = e.coversFrom ?? 1;
    }
    for (const idx of e.cleared ?? []) cleared.add(idx);
  }
  return { ...(summary && { summary }), coversFrom, coversUpTo, cleared };
}

/**
 * 唯一的状态投影:事件日志 → 模型可见的消息序列。
 * 纯函数(同一日志永远投出同一序列),回放与测试都建立在这条性质上。
 *
 * interrupt 事件不投影 —— 打断本身不是模型可见内容。
 * compaction 事件不直接投影,但决定投影:被覆盖的事件跳过、在覆盖起点注入摘要、
 * 被清除的工具结果换成占位文本。
 */
export function deriveMessages(events: readonly AgentEvent[]): Message[] {
  return composeContext(events).messages;
}

/**
 * 一条消息的来历:它来自哪个事件,经过了哪些组装阶段。
 * stages 用固定词:summary(压缩摘要合成)、covered(原文被摘要取代,不出现)、cleared(工具结果换占位)、
 * edited:<字段>(context/edit 改过)、dropped(context/drop 丢弃,不出现)。
 */
export type Provenance = {
  /** 来源事件下标;摘要消息指向 compaction 事件。 */
  event: number;
  stages: string[];
};

export type Composition = {
  messages: Message[];
  /** 与 messages 一一对应。 */
  provenance: Provenance[];
  /** 没进投影的事件下标与原因(covered / dropped),给组装视图列"少了什么"。 */
  omitted: { event: number; reason: "covered" | "dropped" }[];
};

/**
 * 原样投影的消息按事件对象缓存:同一事件在两次投影里给出同一个消息对象。
 * 投影仍是纯函数(缓存的就是它会算出的值);界面比对两次请求的相同前缀时走对象相等的快路径,
 * 长会话回放从二次方降到近线性。改过、被清除、被摘要合成的消息不缓存。消息对象一律只读。
 */
const verbatim = new WeakMap<AgentEvent, Message>();
function remember(e: AgentEvent, m: Message): Message {
  Object.freeze(m);
  verbatim.set(e, m);
  return m;
}

/**
 * 上下文组装:事件数组 → 模型可见的消息序列,带每条的来历。
 * 阶段固定且逐条可见:投影(事件→消息)→ 压缩(覆盖区跳过、切点注入摘要、清除占位)→ 编辑(换字段、丢弃)。
 * 纯函数,同一日志永远同一结果;deriveMessages 只是它的 messages 一列。
 */
export function composeContext(
  events: readonly AgentEvent[],
  /** 只看前 upTo 条:回放历史请求时不用复制前缀。 */
  upTo = events.length,
): Composition {
  const base = (before: number) => baseComposition(events, before);
  const replay = toolReplay(events, upTo, base);
  return applyToolOmissions(base(upTo), replay.omittedAt, upTo);
}

/** 实际输入在 request 自己的历史边界重建,不受后来的清理事实影响。 */
export function requestMessages(events: readonly AgentEvent[], requestIndex: number): Message[] {
  const request = events[requestIndex];
  if (request?.type !== "request") return [];
  return request.body
    ? [...composeContext(events, request.body.prefixEvents).messages, ...request.body.tail]
    : composeContext(events, requestIndex).messages;
}

/** 先形成真正的清理输入,request.body 落盘后后续投影才延续省略。 */
export function prepareToolReplay(events: readonly AgentEvent[], messages: Message[]): Message[] {
  const replay = toolReplay(events, events.length, (before) => baseComposition(events, before));
  return prepareReplay(events, messages, replay.invalid);
}

function baseComposition(events: readonly AgentEvent[], upTo: number): Composition {
  const c = compactionState(events, upTo);
  const ed = editState(events, upTo);
  const messages: Message[] = [];
  const provenance: Provenance[] = [];
  const omitted: Composition["omitted"] = [];
  const recovered = new Map<number, ReturnType<typeof unresolvedCalls>>();
  for (const item of unresolvedCalls(events, upTo)) {
    if (!item.recovery || item.result || ed.dropped.has(item.recovery.event)) continue;
    const list = recovered.get(item.event) ?? [];
    list.push(item);
    recovered.set(item.event, list);
  }
  let unknown: ReturnType<typeof unresolvedCalls> = [];
  const flushUnknown = () => {
    for (const item of unknown) {
      if (!item.recovery) continue;
      const edited = ed.edits.get(item.recovery.event)?.content;
      messages.push({
        role: "tool",
        callId: item.call.id,
        name: item.call.name,
        content: edited ?? item.recovery.content,
        isError: true,
        // 合成内容改变了前缀,其后的签名/密文不能按未变历史回传。
        edited: true,
      });
      provenance.push({
        event: item.recovery.event,
        stages: ["unknown-result", ...(edited !== undefined ? ["edited:content"] : [])],
      });
    }
    unknown = [];
  };
  let summaryEvent = -1;
  for (let i = 0; i < upTo; i++) {
    const e = events[i];
    if (e?.type === "compaction" && e.summary !== undefined && e.coversUpTo === c.coversUpTo) {
      summaryEvent = i;
      break;
    }
  }
  // 豁免固定在摘要发生时的目录;后续绑定只能追加,不能撤走已保留前缀。
  const summaryDirectory = c.summary ? directoryAt(events, summaryEvent) : undefined;
  let prefixChanged = false;
  const push = (m: Message, event: number, stages: string[]) => {
    if (m.role !== "tool") flushUnknown();
    // 仅克隆删除后的第一条保留消息,不能改变历史投影共用的缓存对象。
    messages.push(prefixChanged ? { ...m, prefixChanged: true } : m);
    prefixChanged = false;
    provenance.push({ event, stages });
  };
  for (let i = 0; i < upTo; i++) {
    if (c.summary && i === c.coversFrom) {
      // 摘要是合成的消息,它改变了此后所有消息的前缀:与编辑同等对待,
      // Anthropic 适配器据此不再回传之后的思考块(签名绑定前缀,否则新账号 400)。
      push(
        {
          role: "user",
          content: `[Earlier conversation was compacted; summary follows]\n${c.summary}`,
          edited: true,
        },
        summaryEvent,
        [`summary(covers #${c.coversFrom}–#${c.coversUpTo - 1})`],
      );
    }
    const e = events[i];
    if (!e) continue;
    if (c.summary && i >= c.coversFrom && i < c.coversUpTo && e !== summaryDirectory) {
      if (isProjected(e)) omitted.push({ event: i, reason: "covered" });
      continue;
    }
    if (ed.dropped.has(i)) {
      if (isProjected(e)) {
        omitted.push({ event: i, reason: "dropped" });
        prefixChanged = true;
      }
      continue;
    }
    const edit = ed.edits.get(i);
    const editedStages = Object.keys(edit ?? {}).map((f) => `edited:${f}`);
    switch (e.type) {
      case "session/directory":
        push(verbatim.get(e) ?? remember(e, { role: "user", content: e.environment }), i, [
          "session-directory",
        ]);
        break;
      case "session/start":
        push(
          edit?.system !== undefined
            ? { role: "system", content: systemText(edit.system), edited: true }
            : (verbatim.get(e) ?? remember(e, { role: "system", content: systemText(e.system) })),
          i,
          editedStages,
        );
        break;
      case "user/shell":
        if (e.excludeFromContext) break;
        push(
          edit?.content !== undefined
            ? { role: "user", content: edit.content, edited: true }
            : (verbatim.get(e) ?? remember(e, { role: "user", content: userShellText(e) })),
          i,
          ["user-shell", ...editedStages],
        );
        break;
      case "user/message":
        push(
          edit?.content !== undefined
            ? {
                role: "user",
                content: edit.content,
                edited: true,
                ...(e.images?.length && { images: e.images }),
              }
            : (verbatim.get(e) ??
                remember(e, {
                  role: "user",
                  content: e.text,
                  ...(e.images?.length && { images: e.images }),
                })),
          i,
          editedStages,
        );
        break;
      case "assistant/message": {
        const edited = edit?.text !== undefined || edit?.reasoning !== undefined;
        const hit = edited ? undefined : verbatim.get(e);
        const reasoning = edit?.reasoning ?? e.reasoning;
        const m: Message = hit ?? {
          role: "assistant",
          content: edit?.text ?? e.text,
          toolCalls: e.toolCalls,
          ...(reasoning && { reasoning }),
          ...(e.reasoningKind && { reasoningKind: e.reasoningKind }),
          // 改过的消息不带回传物:签名或密文与改后的内容不再对应,发回去只会被拒。
          ...(!edited && e.opaque !== undefined && { opaque: e.opaque }),
          ...(edited && { edited: true }),
        };
        if (!edited && !hit) remember(e, m);
        push(m, i, [
          ...editedStages,
          ...(edited && e.opaque !== undefined ? ["opaque-dropped"] : []),
        ]);
        unknown = recovered.get(i) ?? [];
        break;
      }
      case "tool/result": {
        // 被清除换成占位文本,同样是改了前缀。
        const cleared = c.cleared.has(i);
        const changed = cleared || edit?.content !== undefined;
        const hit = changed ? undefined : verbatim.get(e);
        const m: Message = hit ?? {
          role: "tool",
          callId: e.callId,
          name: e.name,
          content: cleared ? CLEARED_PLACEHOLDER : (edit?.content ?? e.content),
          isError: e.isError,
          ...(changed && { edited: true }),
        };
        if (!changed && !hit) remember(e, m);
        push(m, i, [
          ...(e.outcome === "unknown" ? ["unknown-result"] : []),
          ...(cleared ? ["cleared"] : []),
          ...editedStages,
        ]);
        break;
      }
      case "session/interrupt":
      case "session/exit":
      case "tool/unresolved":
      case "session/recovered":
      case "ext/event":
      case "session/model":
      case "session/slot":
      case "tools/snapshot":
      case "compaction":
      case "context/edit":
      case "context/drop":
      case "request":
      case "retry":
      case "request/error":
      case "decision":
        break;
    }
  }
  flushUnknown();
  return { messages, provenance, omitted };
}

/** 模型可见的事件类型;其他事件只给人看或间接改变投影。 */
export function isProjected(e: AgentEvent): boolean {
  return (
    e.type === "session/start" ||
    e.type === "session/directory" ||
    e.type === "user/message" ||
    (e.type === "user/shell" && !e.excludeFromContext) ||
    e.type === "assistant/message" ||
    e.type === "tool/result" ||
    e.type === "tool/unresolved"
  );
}
