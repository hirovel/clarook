// 组装视图与上下文面板的动作:模型下一步会看到的每条消息从哪来、经过了什么、落在线路的第几条;
// 选中一条消息能做什么,每项带后果。
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import {
  type Composition,
  compactionState,
  composeContext,
  contextFields,
  editState,
  type Message,
} from "../src/messages.js";
import type { Provider } from "../src/provider.js";
import { thinkingReplayCounts } from "./cards.js";
import { firstLine, fmtTok, indent, messageTokens, roleLabel } from "./inspector-format.js";
import { c, G, selectedText } from "./theme.js";
import { visibleSourceText } from "./tui-format.js";

// ---------- 组装视图:模型下一步会看到的每条消息从哪来、经过了什么、落在线路的第几条 ----------

export type CompositionRow = {
  /** 投影下标(从 1 起,与发送卡、/edit N 的编号不同:那是事件下标)。 */
  i: number;
  /** 来源事件下标。 */
  event: number;
  /** 线路正文里的下标;-1 = 不在数组里(顶层 system);undefined = provider 未实现映射。 */
  wire: number | undefined;
  message: Message;
  stages: string[];
};

export function compositionRows(
  events: readonly AgentEvent[],
  provider?: Provider,
): { rows: CompositionRow[]; omitted: Composition["omitted"] } {
  const comp = composeContext(events);
  const map = provider?.wireMap?.(comp.messages);
  const rows = comp.messages.map((message, k) => ({
    i: k + 1,
    event: comp.provenance[k]?.event ?? -1,
    wire: map ? map[k] : undefined,
    message,
    stages: comp.provenance[k]?.stages ?? [],
  }));
  return { rows, omitted: comp.omitted };
}

export function compositionRow(r: CompositionRow, selected: boolean): string {
  const m = r.message;
  const tok = messageTokens(m);
  const brief = visibleSourceText(
    m.role === "assistant" && !m.content && m.toolCalls.length > 0
      ? `» ${m.toolCalls.map((t) => t.name).join(" ")}`
      : firstLine(m.content),
  );
  const wire = r.wire === undefined ? "  ?" : r.wire < 0 ? "top" : String(r.wire).padStart(3);
  const stages = r.stages.length > 0 ? r.stages.join(" ") : "";
  const body = `${String(r.i).padStart(3)}  ${`#${r.event}`.padEnd(5)} ${wire}  ${roleLabel(m).padEnd(14)} ${String(tok).padStart(6)}  ${stages.padEnd(22)} ${truncateToWidth(brief, 60, "…")}`;
  const mark = selected ? selectedText(G.cursor) : " ";
  const tone = selected ? selectedText(body) : r.stages.length > 0 ? c.jin(body) : c.soft(body);
  return `${mark} ${tone}`;
}

/** 组装视图里一条消息的全文与来历。 */
export function compositionLines(events: readonly AgentEvent[], r: CompositionRow): string[] {
  const m = r.message;
  const src = events[r.event];
  const lines = [
    `${c.soft("projection".padEnd(12))} ${c.ink(`#${r.i} of ${composeContext(events).messages.length}`)}`,
    `${c.soft("source".padEnd(12))} ${c.ink(`event #${r.event} ${src?.type ?? ""}`)}`,
    `${c.soft("wire".padEnd(12))} ${c.ink(r.wire === undefined ? "provider has no wireMap" : r.wire < 0 ? "top-level field (system)" : `messages[${r.wire}]`)}`,
    `${c.soft("stages".padEnd(12))} ${c.ink(r.stages.length > 0 ? r.stages.join(" → ") : "projection only (verbatim from the event)")}`,
    `${c.soft("tokens".padEnd(12))} ${c.ink(`≈${messageTokens(m)}`)}`,
    "",
  ];
  if (src?.type === "session/directory") {
    lines.push(c.soft(contextFields(src)[0]?.readOnlyReason ?? ""), "");
  }
  if (m.role === "assistant" && m.reasoning) {
    lines.push(c.bold(c.soft(`reasoning (${m.reasoningKind ?? "?"})`)));
    lines.push(...indent(visibleSourceText(m.reasoning)).map((l) => c.faint(c.italic(l))));
    lines.push("");
  }
  lines.push(c.bold(c.soft("content")));
  lines.push(
    ...(m.content
      ? indent(visibleSourceText(m.content)).map((l) => c.ink(l))
      : [c.faint("    (empty)")]),
  );
  if (m.role === "assistant" && m.toolCalls.length > 0) {
    lines.push("");
    lines.push(c.bold(c.soft(`tool calls ${m.toolCalls.length}`)));
    for (const tc of m.toolCalls)
      lines.push(
        c.soft(
          `    » ${visibleSourceText(tc.name)} ${visibleSourceText(JSON.stringify(tc.args))}  ${c.faint(visibleSourceText(tc.id))}`,
        ),
      );
  }
  if (m.role === "assistant" && m.opaque !== undefined) {
    lines.push("");
    lines.push(
      c.faint(
        `opaque: ${(m.opaque as { kind?: string }).kind ?? "?"} · saved provider data; replay depends on input eligibility`,
      ),
    );
  }
  return lines;
}

// ---------- 上下文面板的动作:选中一条消息,Enter 列出能做什么,每项带后果 ----------

export type ContextAction =
  | "view"
  | "edit"
  | "edit-reasoning"
  | "compare"
  | "restore"
  | "drop"
  | "rewind"
  | "retry"
  | "fork";

export type ActionItem = { action: ContextAction; label: string; hint: string };

/** 以当前投影判断修改能否生效;历史查看不受限制。 */
export function contextEditRestriction(context: Composition, target: number): string | undefined {
  const omitted = context.omitted.find((item) => item.event === target);
  if (omitted?.reason === "covered")
    return `event #${target} is in compacted history; changing its original does not change the summary`;
  if (omitted?.reason === "dropped")
    return `event #${target} is excluded from current input; its original stays in history`;
  if (context.provenance.some((item) => item.event === target && item.stages.includes("cleared")))
    return `event #${target} was cleared from current input; changing its original does not replace the placeholder`;
  return undefined;
}

export function rewindRestriction(
  events: readonly AgentEvent[],
  target: number,
): string | undefined {
  const compacted = compactionState(events);
  if (compacted.summary && target < compacted.coversUpTo - 1)
    return `cannot rewind to event #${target}: compacted history includes later messages; the summary is kept`;
  return undefined;
}

/** 摘要在投影中的位置早于来源事件;按事件回退无法兑现该行的截止位置。 */
export function contextRewindRestriction(
  events: readonly AgentEvent[],
  row: CompositionRow,
): string | undefined {
  if (row.stages.some((stage) => stage.startsWith("summary")))
    return "cannot rewind to a summary row: its source event follows retained messages";
  return rewindRestriction(events, row.event);
}

/** 这条消息能做的动作。不能做的不列:没编辑过就没有 compare/restore,最后一条没有 rewind。 */
export function actionsFor(
  events: readonly AgentEvent[],
  r: CompositionRow,
  total: number,
): ActionItem[] {
  const src = events[r.event];
  const state = editState(events);
  const context = composeContext(events);
  const restricted = contextEditRestriction(context, r.event);
  const edited = state.edits.has(r.event);
  const fields = restricted ? [] : contextFields(src);
  const out: ActionItem[] = [
    {
      action: "view",
      label: "View full message",
      hint: "content, thinking, tool calls, provenance",
    },
  ];
  if (fields.some((f) => f.field !== "reasoning" && !f.readOnlyReason))
    out.push({
      action: "edit",
      label: "Edit content",
      hint: "edit here; the original stays in history",
    });
  if (fields.some((f) => f.field === "reasoning" && !f.readOnlyReason))
    out.push({
      action: "edit-reasoning",
      label: "Edit thinking",
      hint: "edit full thinking; the provider controls what is sent",
    });
  if (edited) {
    out.push({
      action: "compare",
      label: "Compare with original",
      hint: "line diff, original vs current",
    });
    if (!restricted)
      out.push({
        action: "restore",
        label: "Restore original text",
        hint: "recorded as another edit; nothing is deleted",
      });
  }
  if (
    !restricted &&
    (src?.type === "user/message" ||
      src?.type === "assistant/message" ||
      (src?.type === "user/shell" && !src.excludeFromContext))
  )
    out.push({
      action: "drop",
      label: "Exclude from input",
      hint: "exclude this message; assistant tool results follow it",
    });
  if (
    r.i < total &&
    !contextRewindRestriction(events, r) &&
    events.some(
      (e, i) =>
        i > r.event &&
        !state.dropped.has(i) &&
        (e.type === "user/message" ||
          e.type === "assistant/message" ||
          (e.type === "user/shell" && !e.excludeFromContext)),
    )
  )
    out.push({
      action: "rewind",
      label: "Keep input through here",
      hint: `exclude later messages from input; keep event #${r.event}`,
    });
  if (context.messages.some((message) => message.role === "assistant"))
    out.push({
      action: "retry",
      label: "Retry latest reply",
      hint: "retry the latest assistant reply, regardless of selection",
    });
  out.push({
    action: "fork",
    label: "Fork new session here",
    hint: `copy events up to #${r.event} into a new session file`,
  });
  return out;
}

/** 动作改变哪些内容;缓存影响不能从本地投影推断为供应商命中结果。 */
export function consequenceOf(
  action: ContextAction,
  r: CompositionRow,
  rows: CompositionRow[],
  events: readonly AgentEvent[],
  provider?: Provider,
): string {
  const after = rows.filter((x) => x.i > r.i);
  const afterTok = after.reduce((s, x) => s + messageTokens(x.message), 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const anthropic = provider?.fields?.protocol.startsWith("anthropic") ?? false;
  const messages = rows.map((row) => row.message);
  const thinking =
    anthropic && provider
      ? thinkingReplayCounts(messages, provider.model).kept -
        thinkingReplayCounts(
          rows.map((row) => (row.i === r.i ? { ...row.message, edited: true } : row.message)),
          provider.model,
        ).kept
      : 0;
  const fromHere = [
    after.length > 0
      ? `Later input: ${plural(after.length, "message")} (${fmtTok(afterTok)} tok)`
      : "No later messages in input",
    `Cache: input changes from #${r.event}; hit impact unknown`,
    ...(anthropic && thinking > 0 ? [`Anthropic drops ${plural(thinking, "thinking block")}`] : []),
  ];
  switch (action) {
    case "view":
    case "compare":
      return "read-only · nothing changes";
    case "edit":
    case "edit-reasoning":
    case "restore":
      return [
        "Applies: next message you send",
        "History: original text kept; files unchanged",
        ...fromHere,
      ].join("\n");
    case "drop": {
      const src = events[r.event];
      const calls = src?.type === "assistant/message" ? src.toolCalls.length : 0;
      return [
        "Applies: next message you send",
        `Input: exclude #${r.event}${calls > 0 ? ` with its ${plural(calls, "tool result")}` : ""}`,
        "History: original records kept; files unchanged",
        ...fromHere,
      ].join("\n");
    }
    case "rewind": {
      const excluded = after.filter((row) => events[row.event]?.type !== "session/directory");
      const excludedTok = excluded.reduce((sum, row) => sum + messageTokens(row.message), 0);
      return [
        "Applies: next message you send",
        `Input: keep through #${r.event}; exclude ${plural(excluded.length, "message")} after it (${fmtTok(excludedTok)} tok)`,
        ...(excluded.length < after.length ? ["Session directory remains in input"] : []),
        "History: original records kept; files unchanged",
      ].join("\n");
    }
    case "retry":
      return [
        "Applies: sends an API request immediately; no new prompt",
        "Input: exclude latest reply and its tool results",
        "History: original records kept; tool changes are not undone",
      ].join("\n");
    case "fork":
      return [
        "Applies: saves a session file; no API request",
        `Creates: new session with the first ${r.event + 1} events`,
        "Current session and files unchanged",
      ].join("\n");
  }
}
