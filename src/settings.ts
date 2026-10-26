// 开关登记表:每个可选项一行,键名、分组、类型、可选值、一句说明、内置缺省、生效范围。
// 配置模板的 defaults、/settings 屏、Ctrl+K 的条目都从这一张表生成;命令行解析仍是手写的,
// 由测试逐项核对它认得表里的每个键(tests/settings.test.ts)。加一个开关就是加一行,屏上不会漏。
// 键名是 defaults 下的路径:foldSteps、facts.repeats、prompt.sections、tools.disable。
import { DEFAULT_COMPACTION_SETTINGS, SUMMARY_TEMPLATES } from "./compaction-presets.js";
import type { Preset } from "./config.js";
import { DEFAULT_STATUS_WIDGETS, STATUS_STYLES, STATUS_WIDGETS } from "./status-bar.js";

export type SettingGroup = "display" | "context" | "tools" | "strategy" | "notifications" | "model";

export type SettingType = "bool" | "enum" | "number" | "text" | "list" | "map";

export type SettingValue = { label: string; note?: string };

export type SettingDef = {
  key: string;
  group: SettingGroup;
  type: SettingType;
  /** enum 的可选值;number 的常用值;map 每一项的可选值。 */
  values?: readonly SettingValue[];
  /** list 的可选项(固定的);不给就由界面提供(如工具名)。 */
  items?: readonly string[];
  /** 一句话:这个开关管什么。 */
  note: string;
  /** 内置缺省;undefined = 没有缺省(不写就是不设)。 */
  builtin: unknown;
  /** now = 改完当场生效;next start = 下次启动才生效。 */
  scope: "now" | "next start";
};

export const GROUP_ORDER: readonly SettingGroup[] = [
  "display",
  "context",
  "tools",
  "strategy",
  "notifications",
  "model",
];

const onOff: readonly SettingValue[] = [{ label: "on" }, { label: "off" }];

export const DEFAULT_SKILL_SOURCES: Record<string, "on" | "off"> = {
  "user-clarook": "on",
  "user-claude": "on",
  "project-agents": "on",
  "project-claude": "on",
};

export function parseSkillSources(value: unknown): Record<string, "on" | "off"> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Skill sources must be an object of directory: on/off pairs.");
  for (const [name, enabled] of Object.entries(value))
    if (!name.trim() || (enabled !== "on" && enabled !== "off"))
      throw new Error("Each skill source needs a nonempty name or path and on/off value.");
  return value as Record<string, "on" | "off">;
}

export const SETTINGS: readonly SettingDef[] = [
  {
    key: "saveInputs",
    group: "context",
    type: "bool",
    values: onOff,
    builtin: true,
    scope: "now",
    note: "save drafts and pending inputs locally; restored inputs wait for you",
  },
  // ---------- display ----------
  {
    key: "screen",
    group: "display",
    type: "enum",
    values: [
      { label: "alt", note: "fixed header and status line, own scrolling, mouse, search" },
      { label: "main", note: "keeps the terminal scrollback" },
    ],
    note: "which screen the UI draws on",
    builtin: "alt",
    scope: "next start",
  },
  {
    key: "fold",
    group: "display",
    type: "bool",
    values: onOff,
    note: "tool results start folded · Ctrl+O toggles",
    builtin: true,
    scope: "now",
  },
  {
    key: "foldLines",
    group: "display",
    type: "number",
    values: [{ label: "3" }, { label: "5" }, { label: "10" }, { label: "20" }],
    note: "lines a folded result keeps",
    builtin: 5,
    scope: "now",
  },
  {
    key: "foldSteps",
    group: "display",
    type: "number",
    values: [
      { label: "0", note: "never fold; every step stays open" },
      { label: "1", note: "only the newest step open" },
      { label: "3", note: "the newest three open" },
      { label: "10", note: "the newest ten open" },
    ],
    note: "newest steps stay open, older ones fold to a ledger line · 0 never",
    builtin: 3,
    scope: "now",
  },
  {
    key: "statusStyle",
    group: "display",
    type: "enum",
    values: STATUS_STYLES.map(({ label, note }) => ({ label, note })),
    note: "status-bar layout; preview each choice before applying",
    builtin: "rail",
    scope: "now",
  },
  {
    key: "statusWidgets",
    group: "display",
    type: "list",
    items: STATUS_WIDGETS.map(({ id }) => id),
    note: "status-bar readings; errors and recording failures always remain visible",
    builtin: DEFAULT_STATUS_WIDGETS,
    scope: "now",
  },
  {
    key: "showCostEstimate",
    group: "display",
    type: "bool",
    values: onOff,
    note: "show a token-based cost estimate, never an exact bill; incomplete usage hides the amount",
    builtin: false,
    scope: "now",
  },
  {
    key: "results",
    group: "display",
    type: "map",
    values: [
      { label: "count", note: "only the line count" },
      { label: "head", note: "the first foldLines lines" },
      { label: "tail", note: "the last foldLines lines" },
      { label: "all", note: "everything" },
    ],
    note: "what a tool result shows by default, per tool",
    builtin: {
      read: "count",
      edit: "count",
      write: "count",
      glob: "count",
      grep: "count",
      bash: "tail",
    },
    scope: "now",
  },
  // ---------- context ----------
  {
    key: "compactionRatio",
    group: "context",
    type: "number",
    values: [
      { label: "0", note: "off; use the context reserve" },
      { label: "0.8", note: "suggested when enabled; start by 80% of the window" },
      { label: "0.6", note: "earlier summaries; more frequent and potentially lossy" },
      { label: "0.9", note: "keep more original context before summarizing" },
    ],
    note: "optional early compaction at a fraction of the model window; 0 disables it",
    builtin: 0,
    scope: "now",
  },
  {
    key: "compactionReserve",
    group: "context",
    type: "number",
    values: [{ label: "8000" }, { label: "16384" }, { label: "32000" }, { label: "64000" }],
    note: "compact when the context is this many tokens from the window",
    builtin: DEFAULT_COMPACTION_SETTINGS.compactionReserve,
    scope: "now",
  },
  {
    key: "compactionPrompt",
    group: "context",
    type: "text",
    values: Object.entries(SUMMARY_TEMPLATES).map(([label, template]) => ({
      label,
      note: template.label,
    })),
    note: "summary instructions and expected format; built-in name or Markdown file",
    builtin: DEFAULT_COMPACTION_SETTINGS.compactionPrompt,
    scope: "now",
  },
  {
    key: "compactionMaxTokens",
    group: "context",
    type: "number",
    values: [
      { label: "0", note: "inherit provider output setting" },
      { label: "4096" },
      { label: "13107" },
      { label: "20000" },
    ],
    note: "output token limit for summary requests only; 0 inherits provider settings",
    builtin: DEFAULT_COMPACTION_SETTINGS.compactionMaxTokens,
    scope: "now",
  },
  {
    key: "compactionAcceptance",
    group: "context",
    type: "enum",
    values: [
      { label: "complete", note: "apply a complete nonempty summary; size may increase" },
      { label: "smaller", note: "apply only when the projected context becomes smaller" },
      { label: "reduced", note: "require more than 10% summary reduction and a smaller context" },
    ],
    note: "when a completed summary replaces older context",
    builtin: DEFAULT_COMPACTION_SETTINGS.compactionAcceptance,
    scope: "now",
  },
  {
    key: "facts.repeats",
    group: "context",
    type: "bool",
    values: onOff,
    note: "a tool result notes an earlier failure with the same arguments",
    builtin: true,
    scope: "now",
  },
  {
    key: "facts.slow",
    group: "context",
    type: "bool",
    values: onOff,
    note: "a tool result notes a call far slower than this session's median",
    builtin: true,
    scope: "now",
  },
  {
    key: "facts.date",
    group: "context",
    type: "bool",
    values: onOff,
    note: "a date change is appended as one line before the next request",
    builtin: true,
    scope: "now",
  },
  {
    key: "plan",
    group: "context",
    type: "bool",
    values: onOff,
    note: "the plan tool is offered · off saves 170–250 tok per request",
    builtin: true,
    scope: "now",
  },
  {
    key: "planReminder",
    group: "context",
    type: "number",
    values: [
      { label: "0", note: "off; recovery after compaction is separate" },
      { label: "4" },
      { label: "8" },
      { label: "16" },
    ],
    note: "restate the plan after this many steps without an update · 0 never",
    builtin: 0,
    scope: "now",
  },
  {
    key: "prompt.sections",
    group: "context",
    type: "list",
    items: ["role", "env", "instructions", "memory", "skills", "append"],
    note: "system prompt sections, in order · Ctrl+E on the system row flips one for this session",
    builtin: ["role", "env", "instructions", "memory", "skills", "append"],
    scope: "next start",
  },
  {
    key: "prompt.instructionsAs",
    group: "context",
    type: "enum",
    values: [
      { label: "system", note: "project instructions and memory in the system prompt" },
      { label: "user", note: "in the first user message" },
    ],
    note: "where project instructions go",
    builtin: "system",
    scope: "next start",
  },
  {
    key: "prompt.memory",
    group: "context",
    type: "bool",
    values: onOff,
    note: "cross-session memory: the memory section of AGENTS.md and the remember tool",
    builtin: false,
    scope: "next start",
  },
  {
    key: "prompt.skills.mode",
    group: "context",
    type: "enum",
    values: [
      { label: "manual", note: "invoke /name yourself; no skill catalog in requests" },
      { label: "auto", note: "the model can choose from the offered catalog; adds context" },
    ],
    note: "who chooses when to load a skill",
    builtin: "manual",
    scope: "now",
  },
  {
    key: "prompt.skills.sources",
    group: "context",
    type: "map",
    values: onOff,
    note: "skill discovery directories; enable, add or remove sources",
    builtin: DEFAULT_SKILL_SOURCES,
    scope: "now",
  },
  {
    key: "prompt.skills.include",
    group: "context",
    type: "list",
    note: "automatic skill range: all includes future discoveries; a list fixes the names",
    builtin: "all",
    scope: "now",
  },
  {
    key: "prompt.skills.load",
    group: "context",
    type: "enum",
    values: [
      { label: "read", note: "catalog in system prompt; instructions arrive in a read result" },
      {
        label: "tool",
        note: "catalog in skill tool definition; instructions arrive in its result",
      },
    ],
    note: "how the model loads a skill it picked",
    builtin: "read",
    scope: "now",
  },
  // ---------- tools ----------
  {
    key: "tools.disable",
    group: "tools",
    type: "list",
    note: "built-in tools not offered · /tools flips them for a session",
    builtin: undefined,
    scope: "now",
  },
  {
    key: "toolPrompts",
    group: "tools",
    type: "enum",
    values: [
      { label: "brief", note: "core sentence only" },
      { label: "explain", note: "core and guidance" },
      { label: "rules", note: "core, guidance and ALWAYS / NEVER rules" },
    ],
    note: "how much of each tool description the model sees",
    builtin: "explain",
    scope: "now",
  },
  {
    key: "mcpReconnect",
    group: "tools",
    type: "list",
    builtin: [],
    scope: "now",
    note: "MCP servers to reconnect when switching sessions; other healthy connections are reused.",
  },
  {
    key: "subagent",
    group: "tools",
    type: "bool",
    values: onOff,
    note: "the task tool is offered (sub-agents)",
    builtin: false,
    scope: "next start",
  },
  {
    key: "maxSteps",
    group: "tools",
    type: "number",
    values: [{ label: "20" }, { label: "50" }, { label: "100" }],
    note: "steps a turn may take before the loop stops · unset means no limit",
    builtin: undefined,
    scope: "next start",
  },
  // ---------- strategy (start values of the slots; /set changes this session) ----------
  {
    key: "approve",
    group: "strategy",
    type: "enum",
    values: [
      { label: "all", note: "never ask" },
      { label: "ask", note: "ask before every tool call" },
      { label: "policy", note: "rules decide" },
    ],
    note: "approval at start · /set changes this session",
    builtin: "all",
    scope: "now",
  },
  {
    key: "compaction",
    group: "strategy",
    type: "text",
    values: [
      {
        label: "llm",
        note: "Summarize older history with a model call; keep recent history verbatim.",
      },
      {
        label: "clear",
        note: "Remove old tool output from context; keep the original history. No model call.",
      },
      {
        label: "pipeline",
        note: "Clear old tool output first; summarize if the context is still above the target.",
      },
    ],
    note: "compaction strategy at start",
    builtin: "llm",
    scope: "now",
  },
  {
    key: "compactionTrigger",
    group: "strategy",
    type: "enum",
    values: [
      { label: "threshold", note: "automatically past the threshold" },
      { label: "manual", note: "only on /compact" },
      { label: "remind", note: "the status line says when you are past it" },
    ],
    note: "when compaction runs",
    builtin: "threshold",
    scope: "now",
  },
  {
    key: "preservation",
    group: "strategy",
    type: "text",
    values: [
      { label: "auto", note: "20k tokens, capped at one quarter of the window" },
      { label: "tokens 20000" },
      { label: "tokens 50000" },
      { label: "ratio 0.3" },
      { label: "ratio 0.5" },
    ],
    note: "how much recent context compaction keeps verbatim",
    builtin: DEFAULT_COMPACTION_SETTINGS.preservation,
    scope: "now",
  },
  {
    key: "execution",
    group: "strategy",
    type: "enum",
    values: [
      { label: "sequential", note: "one tool call at a time" },
      { label: "parallel", note: "adjacent read-only calls together" },
    ],
    note: "how a batch of tool calls runs",
    builtin: "sequential",
    scope: "now",
  },
  {
    key: "steering",
    group: "strategy",
    type: "enum",
    values: [
      { label: "step", note: "a queued message goes in at the next step" },
      { label: "turn", note: "after the model stops calling tools" },
    ],
    note: "when a queued message reaches the model",
    builtin: "step",
    scope: "now",
  },
  // ---------- notifications ----------
  {
    key: "checkUpdates",
    group: "notifications",
    type: "bool",
    values: onOff,
    note: "check for a newer release at startup; network request only, no automatic installation",
    builtin: true,
    scope: "next start",
  },
  {
    key: "notify",
    group: "notifications",
    type: "enum",
    values: [
      { label: "unfocused", note: "only while the terminal is not focused" },
      { label: "always" },
      { label: "off" },
    ],
    note: "desktop notification when a turn ends or approval waits",
    builtin: "unfocused",
    scope: "now",
  },
  // ---------- model ----------
  {
    key: "model",
    group: "model",
    type: "text",
    note: "provider/model to use; unset follows the configured default model",
    builtin: undefined,
    scope: "now",
  },
  {
    key: "effort",
    group: "model",
    type: "enum",
    values: [
      { label: "off" },
      { label: "low" },
      { label: "medium" },
      { label: "high" },
      { label: "xhigh" },
      { label: "max" },
    ],
    note: "reasoning effort at start · the model may support fewer levels",
    builtin: undefined,
    scope: "now",
  },
];

export function settingDef(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/** 按路径读一个预设里的值;没写返回 undefined。 */
export function getSetting(preset: Preset | undefined, key: string): unknown {
  let cur: unknown = preset;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 按路径写一个值,返回新对象(不改原对象);value 为 undefined 就删掉那一项,空对象也一并删。 */
export function setSetting(preset: Preset | undefined, key: string, value: unknown): Preset {
  const parts = key.split(".");
  const write = (obj: Record<string, unknown> | undefined, i: number): Record<string, unknown> => {
    const out = { ...obj };
    const part = parts[i] as string;
    if (i === parts.length - 1) {
      if (value === undefined) delete out[part];
      else out[part] = value;
      return out;
    }
    const child = write(out[part] as Record<string, unknown> | undefined, i + 1);
    if (Object.keys(child).length === 0) delete out[part];
    else out[part] = child;
    return out;
  };
  return write(preset as Record<string, unknown> | undefined, 0) as Preset;
}

/** 内置缺省组成的预设:配置模板的 defaults 就是它。 */
export function defaultPreset(): Preset {
  let out: Preset = {};
  for (const s of SETTINGS) if (s.builtin !== undefined) out = setSetting(out, s.key, s.builtin);
  return out;
}

/** 打字形态 → 值。抛错的话信息就是给人看的那一句。 */
export function parseSetting(def: SettingDef, text: string): unknown {
  const t = text.trim();
  switch (def.type) {
    case "bool":
      if (/^(on|true|yes|1)$/i.test(t)) return true;
      if (/^(off|false|no|0)$/i.test(t)) return false;
      throw new Error(`${def.key} takes on or off`);
    case "number": {
      const n = Number(t);
      if (def.key === "compactionRatio") {
        if (!t || !Number.isFinite(n) || n < 0 || n >= 1)
          throw new Error("compactionRatio takes 0 (off) or a fraction between 0 and 1");
        return n;
      }
      if (/^(none|unset|-)$/i.test(t)) return undefined;
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
        throw new Error(`${def.key} takes a whole number`);
      return n;
    }
    case "enum": {
      const ok = def.values?.some((v) => v.label === t);
      if (!ok)
        throw new Error(`${def.key} takes ${def.values?.map((v) => v.label).join(" · ") ?? ""}`);
      return t;
    }
    case "text":
      if (/^(none|unset|-)$/i.test(t)) return undefined;
      return t;
    case "list": {
      if (def.key === "prompt.skills.include") {
        if (t === "all") return "all";
        if (t === "[]" || t === "none") return [];
      }
      if (def.key === "statusWidgets" && (t === "[]" || t === "none")) return [];
      if (/^(none|unset|-)$/i.test(t)) return undefined;
      const items = t.split(/[\s,]+/).filter(Boolean);
      if (def.items) {
        const bad = items.find((i) => !def.items?.includes(i));
        if (bad) throw new Error(`${def.key}: ${bad} is not one of ${def.items.join(" ")}`);
      }
      return items;
    }
    case "map": {
      if (def.key === "prompt.skills.sources") return parseSkillSources(JSON.parse(t));
      // "read count bash tail" 或 "read=count"
      if (/^(none|unset|-)$/i.test(t)) return undefined;
      const parts = t.split(/[\s,=]+/).filter(Boolean);
      if (parts.length % 2 !== 0) throw new Error(`${def.key} takes pairs: name value name value`);
      const out: Record<string, string> = {};
      for (let i = 0; i < parts.length; i += 2) {
        const v = parts[i + 1] as string;
        if (def.values && !def.values.some((x) => x.label === v))
          throw new Error(
            `${def.key}: ${v} is not one of ${def.values.map((x) => x.label).join(" · ")}`,
          );
        out[parts[i] as string] = v;
      }
      return out;
    }
  }
}

/** 值 → 屏上的一小段。 */
export function formatSetting(def: SettingDef, value: unknown): string {
  if (value === undefined || value === null) return def.type === "bool" ? "off" : "none";
  switch (def.type) {
    case "bool":
      return value ? "on" : "off";
    case "list":
      if (value === "all" && def.key === "prompt.skills.include") return "all";
      return Array.isArray(value) && value.length > 0 ? value.join(" · ") : "none";
    case "map": {
      const entries = Object.entries(value as Record<string, string>);
      if (entries.length === 0) return "none";
      const head = entries.slice(0, 2).map(([k, v]) => `${k} ${v}`);
      return entries.length > 2
        ? `${head.join(" · ")} · ${entries.length - 2} more`
        : head.join(" · ");
    }
    default:
      return String(value);
  }
}

export type SettingLayers = {
  /** 配置 defaults。 */
  defaults?: Preset | undefined;
  /** --preset 指的预设与它的名字。 */
  preset?: Preset | undefined;
  presetName?: string | undefined;
};

/**
 * 这个值是谁定的。解析顺序是 命令行 > 预设 > defaults > 内置,所以从高往低找第一个与生效值相等的层;
 * 都不等就是命令行给的。
 */
export function settingSource(def: SettingDef, effective: unknown, layers: SettingLayers): string {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const fromPreset = getSetting(layers.preset, def.key);
  if (fromPreset !== undefined && same(fromPreset, effective))
    return `preset ${layers.presetName ?? ""}`.trim();
  const fromConfig = getSetting(layers.defaults, def.key);
  if (fromConfig !== undefined && same(fromConfig, effective)) return "config";
  if (same(def.builtin, effective)) return "built-in";
  return "flag";
}
