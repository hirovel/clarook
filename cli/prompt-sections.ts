// 系统提示词的段,会话内可开关:段的正文从 session/start 的全文按各段长度切回来(各段修剪后以空行相接),
// 当前开着哪几段看投影里的 system 含不含那一段;翻一段就是追加一条 context/edit(target 0, field system),
// 与编辑任何消息同一条路,原文永远留在事件里。旧日志的段长度对不上全文时只看不改。
import { type AgentEvent, now } from "../src/events.js";
import { editState } from "../src/messages.js";
import type { PromptSection } from "./prompt.js";

export type SectionState = {
  name: string;
  source?: string | undefined;
  text: string;
  chars: number;
  on: boolean;
};

type Start = Extract<AgentEvent, { type: "session/start" }>;

function startOf(events: readonly AgentEvent[]): { e: Start; index: number } | undefined {
  const index = events.findIndex((e) => e.type === "session/start");
  const e = events[index];
  return e?.type === "session/start" ? { e, index } : undefined;
}

/** 投影里当前的系统提示词全文(编辑过就是编辑后的)。 */
export function currentSystem(events: readonly AgentEvent[]): string | undefined {
  const s = startOf(events);
  if (!s) return undefined;
  return editState(events).edits.get(s.index)?.system ?? s.e.system;
}

/**
 * 只有分段能精确重建当前全文时才提供开关,不能用原文子串猜测手改文字的归属。
 */
export function sectionStates(events: readonly AgentEvent[]): SectionState[] | undefined {
  const current = currentSystem(events);
  if (current === undefined) return undefined;
  const states = recoverSections(events, current);
  return states
    ?.filter((s) => s.on)
    .map((s) => s.text)
    .join("\n\n") === current
    ? states
    : undefined;
}

/** 恢复已记录的原段,供具名段精确替换;不代表任意手改全文仍可按原段切换。 */
function recoverSections(
  events: readonly AgentEvent[],
  current: string,
): SectionState[] | undefined {
  const s = startOf(events);
  if (!s) return undefined;
  let full = s.e.system;
  let sections = s.e.sections;
  const inactive = new Map<string, { section: SectionState; index: number }>();
  let previousSystem = full;
  for (const e of events) {
    if (e.type === "context/edit" && e.target === s.index && e.field === "system") {
      if (e.sections) {
        // 重组活跃段时,此前关闭的段仍可重新开启;正文继续取自已有事件。
        for (const [index, old] of (
          splitSections(full, sections, previousSystem) ?? []
        ).entries()) {
          if (!old.on && !e.sections.some((m) => m.name === old.name))
            inactive.set(old.name, { section: old, index });
        }
        full = e.value;
        sections = e.sections;
      }
      previousSystem = e.value;
    }
  }
  const active = splitSections(full, sections, current);
  if (!active) return undefined;
  for (const { section: old, index } of inactive.values())
    if (!active.some((s) => s.name === old.name))
      active.splice(Math.min(index, active.length), 0, { ...old, on: current.includes(old.text) });
  return active;
}

function splitSections(
  full: string,
  sections: Start["sections"],
  now: string,
): SectionState[] | undefined {
  if (!sections) return undefined;
  const expected = sections.reduce((n, x) => n + x.chars, 0) + 2 * Math.max(0, sections.length - 1);
  if (expected !== full.length) return undefined;
  const out: SectionState[] = [];
  let at = 0;
  for (let k = 0; k < sections.length; k++) {
    const m = sections[k] as { name: string; source?: string; chars: number };
    const text = full.slice(at, at + m.chars);
    const last = k === sections.length - 1;
    if (!last && full.slice(at + m.chars, at + m.chars + 2) !== "\n\n") return undefined;
    at += m.chars + 2;
    out.push({ name: m.name, source: m.source, text, chars: m.chars, on: now.includes(text) });
  }
  return out;
}

/** 翻一段之后的系统提示词全文:开着的段按原顺序以空行相接。 */
export function systemWithSections(states: SectionState[], toggled: string): string {
  return states
    .filter((x) => (x.name === toggled ? !x.on : x.on))
    .map((x) => x.text)
    .join("\n\n");
}

/** 只替换指定目录段。手动编辑过的其余全文原样保留,不重新读取项目指令。 */
export function replaceSystemSection(
  events: readonly AgentEvent[],
  name: string,
  replacement?: PromptSection,
): Extract<AgentEvent, { type: "context/edit" }> | undefined {
  const start = startOf(events);
  if (!start) return undefined;
  const current = currentSystem(events) ?? "";
  const states = recoverSections(events, current);
  let sections: PromptSection[];
  if (
    states &&
    states
      .filter((s) => s.on)
      .map((s) => s.text)
      .join("\n\n") === current
  ) {
    sections = states
      .filter((s) => s.on && s.name !== name)
      .map((s) => ({ name: s.name, text: s.text, ...(s.source && { source: s.source }) }));
    const at = states.filter((s) => s.on).findIndex((s) => s.name === name);
    if (replacement) sections.splice(at < 0 ? sections.length : at, 0, replacement);
  } else {
    // 无法按段还原时,只移除仍能精确匹配的旧目录,不猜测用户写过的内容。
    const old = states?.find((s) => s.name === name)?.text;
    const remaining = old ? current.replace(old, "").trim() : current;
    sections = [
      ...(remaining ? [{ name: "Custom", text: remaining }] : []),
      ...(replacement ? [replacement] : []),
    ];
  }
  const value = sections.map((s) => s.text).join("\n\n");
  if (value === current) return undefined;
  return {
    type: "context/edit",
    at: now(),
    target: start.index,
    field: "system",
    value,
    sections: sections.map((s) => ({
      name: s.name,
      chars: s.text.length,
      ...(s.source && { source: s.source }),
    })),
  };
}
