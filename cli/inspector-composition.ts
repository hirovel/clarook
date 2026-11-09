// 组装视图与上下文面板的动作:模型下一步会看到的每条消息从哪来、经过了什么、落在线路的第几条;
// 选中一条消息能做什么,每项带后果。
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type ContextAction as ChangeAction, contextView } from "../src/context-edit.js";
import type { AgentEvent } from "../src/events.js";
import type { Composition, Message } from "../src/messages.js";
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
  const comp = contextView(events).composition;
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
  const view = contextView(events, r.event);
  const lines = [
    `${c.soft("projection".padEnd(12))} ${c.ink(`#${r.i} of ${view.composition.messages.length}`)}`,
    `${c.soft("source".padEnd(12))} ${c.ink(`event #${r.event} ${src?.type ?? ""}`)}`,
    `${c.soft("wire".padEnd(12))} ${c.ink(r.wire === undefined ? "provider has no wireMap" : r.wire < 0 ? "top-level field (system)" : `messages[${r.wire}]`)}`,
    `${c.soft("stages".padEnd(12))} ${c.ink(r.stages.length > 0 ? r.stages.join(" → ") : "projection only (verbatim from the event)")}`,
    `${c.soft("tokens".padEnd(12))} ${c.ink(`≈${messageTokens(m)}`)}`,
    "",
  ];
  if (src?.type === "session/directory") {
    lines.push(c.soft(view.fields[0]?.readOnlyReason ?? ""), "");
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

export type ContextAction = ChangeAction | "view" | "fork";

export type ActionItem = { action: ContextAction; label: string; hint: string };

/** 这里只把内核给出的动作翻成菜单文案。 */
export function contextActionItem(action: ContextAction, target: number): ActionItem {
  const text: Record<ContextAction, [string, string]> = {
    view: ["View full message", "content, thinking, tool calls, provenance"],
    edit: ["Edit content", "edit here; the original stays in history"],
    "edit-reasoning": ["Edit thinking", "edit full thinking; the provider controls what is sent"],
    compare: ["Compare with original", "line diff, original vs current"],
    restore: ["Restore original text", "recorded as another edit; nothing is deleted"],
    drop: ["Exclude from input", "exclude this message; assistant tool results follow it"],
    rewind: ["Keep input through here", `exclude later messages from input; keep event #${target}`],
    retry: ["Retry latest reply", "retry the latest assistant reply, regardless of selection"],
    "toggle-section": ["System sections", "choose a section to edit or toggle"],
    fork: ["Fork new session here", `copy events up to #${target} into a new session file`],
  };
  const [label, hint] = text[action];
  return { action, label, hint };
}

/** 后果只格式化内核给出的影响;缓存命中仍需供应商用量确认。 */
export function consequenceOf(
  action: ContextAction,
  r: CompositionRow,
  view: ReturnType<typeof contextView>,
  provider?: Provider,
): string {
  if (action === "view" || action === "compare") return "read-only · nothing changes";
  if (action === "toggle-section")
    return "Choose a section to edit its text or toggle it for the next request.";
  if (action === "fork")
    return [
      "Applies: saves a session file; no API request",
      `Creates: new session with the first ${r.event + 1} events`,
      "Current session and files unchanged",
    ].join("\n");
  const effect = view.effects[action];
  if (!effect) return view.restrictions[action] ?? "This action is unavailable.";
  const messages = view.composition.messages;
  const changed = effect.prefixFrom ?? r.i - 1;
  const after = messages.slice(r.i);
  const afterTok = after.reduce((sum, message) => sum + messageTokens(message), 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const thinking = provider?.fields?.protocol.startsWith("anthropic")
    ? thinkingReplayCounts(messages, provider.model).kept -
      thinkingReplayCounts(
        messages.map((message, index) =>
          index === changed ? { ...message, edited: true } : message,
        ),
        provider.model,
      ).kept
    : 0;
  const fromHere = [
    after.length > 0
      ? `Later input: ${plural(after.length, "message")} (${fmtTok(afterTok)} tok)`
      : "No later messages in input",
    `Cache: input changes from #${effect.target}; hit impact unknown`,
    ...(thinking > 0 ? [`Anthropic drops ${plural(thinking, "thinking block")}`] : []),
  ];
  switch (action) {
    case "edit":
    case "edit-reasoning":
    case "restore":
      return [
        "Applies: next message you send",
        "History: original text kept; files unchanged",
        ...fromHere,
      ].join("\n");
    case "drop": {
      const results = effect.removed.filter(({ message }) => message.role === "tool").length;
      return [
        "Applies: next message you send",
        `Input: exclude #${effect.target}${results > 0 ? ` with its ${plural(results, "tool result")}` : ""}`,
        "History: original records kept; files unchanged",
        ...fromHere,
      ].join("\n");
    }
    case "rewind": {
      const tok = effect.removed.reduce((sum, { message }) => sum + messageTokens(message), 0);
      return [
        "Applies: next message you send",
        `Input: keep through #${effect.target}; exclude ${plural(effect.removed.length, "message")} after it (${fmtTok(tok)} tok)`,
        ...(effect.removed.length < after.length ? ["Other later input remains unchanged"] : []),
        "History: original records kept; files unchanged",
      ].join("\n");
    }
    case "retry":
      return [
        "Applies: sends an API request immediately; no new prompt",
        `Input: exclude latest reply and its ${plural(effect.removed.filter(({ message }) => message.role === "tool").length, "tool result")}`,
        "History: original records kept; tool changes are not undone",
      ].join("\n");
  }
}
