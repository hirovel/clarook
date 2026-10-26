import type { SessionSetup } from "./session-setup.js";

// 设置的读写语义与终端布局分离。运行值来自现有状态;保存值来自配置;变化进入事件日志。

import { DEFAULT_COMPACTION_SETTINGS } from "../src/compaction-presets.js";
import type { Preset, ResultView, SkillsConfig } from "../src/config.js";
import { now } from "../src/events.js";
import { DEFAULT_PLAN_REMINDER } from "../src/plan.js";
import type { EffortLevel } from "../src/provider.js";
import { errorMessage } from "../src/providers/errors.js";
import {
  formatSetting,
  getSetting,
  parseSetting,
  parseSkillSources,
  SETTINGS,
  type SettingDef,
  type SettingLayers,
  setSetting,
  settingDef,
  settingSource,
} from "../src/settings.js";
import { configuredValue, type SetupScope, sameSetting, setupSnapshot } from "../src/setup.js";
import { parsePreservation } from "./args.js";
import { DEFAULT_RESULT_VIEWS } from "./cards.js";
import { automaticSkills, discoverSkills, skillsSection } from "./prompt.js";
import { replaceSystemSection } from "./prompt-sections.js";
import { buildCompaction, loadSummaryPrompt, validateCompactionName } from "./strategies.js";
import { applyToolPrompts } from "./tool-prompts.js";
import { createSkillTool, skillCatalog } from "./tools/skill.js";
import type { TuiContext } from "./tui-context.js";
import { applySlotValue, currentCompactionSettings } from "./tui-slots.js";

/** 模型切换只更新实际运行值;显示和保存默认值由各入口负责。 */
export function switchModel(ctx: TuiContext, name: string): void {
  if (!ctx.deps.settings) throw new Error("settings interface not configured");
  if (ctx.agent.running) throw new Error("cannot switch models while running; press Esc first");
  const choice = ctx.deps.settings.switchModel(name);
  ctx.agent.setProvider(choice.provider);
  ctx.model.info = {
    ...ctx.model.info,
    model: choice.model,
    providerName: choice.providerName,
    contextWindow: choice.contextWindow,
    ...(choice.capabilitySource && { capabilitySource: choice.capabilitySource }),
  };
  ctx.model.effortLevels = choice.effortLevels;
  ctx.model.contextWindow = choice.contextWindow;
  ctx.compaction.window = choice.contextWindow;
  if (currentCompactionSettings(ctx).preservation === "auto")
    ctx.compaction.preservation = parsePreservation("auto", choice.contextWindow).policy;
  ctx.updateHeader();
  ctx.updateStatus();
}

export function effectiveSetting(ctx: TuiContext, def: SettingDef): unknown {
  const baseValue = () => getSetting(ctx.setupBase, def.key) ?? def.builtin;
  if (Object.hasOwn(DEFAULT_COMPACTION_SETTINGS, def.key))
    return getSetting(currentCompactionSettings(ctx), def.key);
  switch (def.key) {
    case "saveInputs":
      return ctx.deps.inputs?.saving ?? ctx.deps.saveInputs ?? true;
    case "model":
      return `${ctx.model.info.providerName}/${ctx.model.info.model}`;
    case "mcpReconnect":
      return ctx.deps.mcpReconnect ?? [];
    case "screen":
      return ctx.deps.screen ?? "alt";
    case "fold":
      return ctx.view.foldResults;
    case "foldLines":
      return ctx.view.foldLines;
    case "foldSteps":
      return ctx.view.foldSteps;
    case "statusStyle":
      return ctx.deps.statusStyle ?? "rail";
    case "statusWidgets":
      return ctx.deps.statusWidgets ?? def.builtin;
    case "showCostEstimate":
      return ctx.deps.showCostEstimate ?? false;
    case "results":
      return ctx.view.results;
    case "notify":
      return ctx.deps.notify ?? "unfocused";
    case "facts.repeats":
    case "facts.slow":
    case "facts.date": {
      const key = def.key.slice(6) as "repeats" | "slow" | "date";
      return ctx.agent.facts?.[key] ?? true;
    }
    case "plan":
      return ctx.tools.some((t) => t.name === "plan") && !ctx.slots.disabledTools.has("plan");
    case "planReminder":
      return ctx.agent.planReminder ?? DEFAULT_PLAN_REMINDER;
    case "tools.disable": {
      const off = [...ctx.slots.disabledTools].filter((n) => n !== "plan");
      return off.length > 0 ? off : undefined;
    }
    case "toolPrompts":
      return ctx.slots.toolPrompts.style ?? "explain";
    case "approve":
      return ctx.approval.mode;
    case "execution":
      return ctx.agent.slots.execution ?? "sequential";
    case "steering":
      return ctx.slots.state.steering ?? "step";
    case "effort":
      return ctx.agent.effort;
    default:
      return baseValue();
  }
}

export function sourceOf(ctx: TuiContext, def: SettingDef, effective: unknown): string {
  for (let i = ctx.log.events.length - 1; i >= 0; i--) {
    const e = ctx.log.events[i];
    if (
      e?.type === "ext/event" &&
      e.source === "setup" &&
      e.kind === "setting" &&
      e.payload.key === def.key &&
      e.payload.scope === "session"
    ) {
      if (sameSetting(e.payload.value, effective)) return "recorded change in this session";
      break;
    }
  }
  const layers: SettingLayers = ctx.deps.settings?.settingLayers?.() ?? {};
  const source = settingSource(def, effective, layers);
  // 值相同不证明来源:显式参数也可能恰好等于默认值。
  return source === "flag" ? "runtime value; source not recorded" : `matches ${source}`;
}

export function setupRead(ctx: TuiContext, def: SettingDef, scope: SetupScope): unknown {
  if (def.key === "model" && scope === "defaults")
    return (
      getSetting(ctx.deps.settings?.settingLayers?.().defaults, "model") ??
      ctx.deps.settings?.defaultModel?.()
    );
  return scope === "session"
    ? effectiveSetting(ctx, def)
    : configuredValue(def, ctx.deps.settings?.settingLayers?.().defaults);
}

const SLOT_SETTINGS = new Set([
  "model",
  "approve",
  "compaction",
  "compactionTrigger",
  "compactionPrompt",
  "compactionMaxTokens",
  "compactionAcceptance",
  "preservation",
  "execution",
  "steering",
  "toolPrompts",
]);
const DISPLAY_SETTINGS = new Set([
  "fold",
  "foldLines",
  "foldSteps",
  "statusStyle",
  "statusWidgets",
  "results",
  "showCostEstimate",
  "notify",
]);

export function settingTiming(ctx: TuiContext, def: SettingDef, scope: SetupScope): string {
  if (scope === "defaults") return "Saved for future starts; this session stays unchanged.";
  if (def.key === "saveInputs")
    return "Changes local input saving now. Turning off removes the saved snapshot, keeping inputs in memory.";
  if (def.key === "mcpReconnect") return "Applies when the next session connection is prepared.";
  if (def.key === "prompt.skills.sources")
    return "Rescans while idle. Wait for the current turn before changing sources. Loaded instructions stay in history.";
  if (def.scope === "next start")
    return "Requires a restart. Switch to Saved defaults to change it.";
  if (def.key === "plan" && !ctx.tools.some((t) => t.name === "plan"))
    return "Plan tool is not loaded. Enable it in Saved defaults and restart.";
  if (ctx.agent.running && SLOT_SETTINGS.has(def.key))
    return "This strategy cannot change mid-turn. Wait, or close setup and press Esc to interrupt.";
  if (DISPLAY_SETTINGS.has(def.key)) return "Changes the interface immediately.";
  if (def.key === "effort") return "Used by the next model request.";
  if (def.key.startsWith("prompt.skills."))
    return "Used by the next request. Loaded instructions stay in history. New files are discovered at session startup.";
  if (
    [
      "compaction",
      "compactionTrigger",
      "compactionReserve",
      "compactionRatio",
      "compactionPrompt",
      "compactionMaxTokens",
      "compactionAcceptance",
      "preservation",
    ].includes(def.key)
  )
    return "Used by the next compaction check; existing history stays unchanged.";
  return "Used by the next turn. An in-flight request keeps its current settings.";
}

/** 实际修改运行状态;调用前由 changeSetting 验证作用域和生效条件。 */
export async function applySettingNow(
  ctx: TuiContext,
  def: SettingDef,
  value: unknown,
): Promise<void> {
  const { view } = ctx;
  switch (def.key) {
    case "prompt.skills.mode":
    case "prompt.skills.include":
    case "prompt.skills.load":
    case "prompt.skills.sources": {
      const read = (key: string) =>
        key === def.key ? value : effectiveSetting(ctx, settingDef(key) as SettingDef);
      const config: SkillsConfig = {
        mode: read("prompt.skills.mode") as "manual" | "auto",
        include: read("prompt.skills.include") as "all" | string[],
        load: read("prompt.skills.load") as "read" | "tool",
        sources: read("prompt.skills.sources") as Record<string, "on" | "off">,
      };
      const warnings: string[] = [];
      const skills =
        def.key === "prompt.skills.sources"
          ? discoverSkills(process.cwd(), {
              ...(config.sources && { sources: config.sources }),
              onError: (error) => warnings.push(error.message),
            })
          : ctx.skills;
      const catalog = automaticSkills(skills, config);
      const existing = ctx.tools.find((t) => t.name === "skill");
      if (config.load === "tool" && catalog.length && existing && !skillCatalog(existing))
        throw new Error(
          "An extension owns the skill tool. Choose read loading or remove that extension first.",
        );
      const tools = ctx.tools.filter((t) => !skillCatalog(t));
      if (config.load === "tool" && catalog.length) {
        const tool = createSkillTool(catalog);
        applyToolPrompts([tool], ctx.slots.toolPrompts);
        tools.push(tool);
      }
      const edit = replaceSystemSection(ctx.log.events, "Skills", skillsSection(skills, config));
      if (edit) ctx.log.append(edit);
      if (skills !== ctx.skills) ctx.skills.splice(0, ctx.skills.length, ...skills);
      ctx.tools.splice(0, ctx.tools.length, ...tools);
      ctx.setupBase = setSetting(ctx.setupBase, def.key, structuredClone(value));
      ctx.applyTools?.();
      for (const message of warnings)
        ctx.log.append({
          type: "ext/event",
          at: now(),
          source: "skills",
          kind: "load-error",
          payload: { message },
        });
      return;
    }
    case "saveInputs":
      ctx.deps.inputs?.configure(value as boolean);
      ctx.deps.saveInputs = value as boolean;
      return;
    case "mcpReconnect":
      ctx.deps.mcpReconnect = value as string[];
      break;
    case "model": {
      const name = value ?? ctx.deps.settings?.defaultModel?.();
      if (!name)
        throw new Error("No default model is configured. Choose a model or use /login first.");
      switchModel(ctx, String(name));
      return;
    }
    case "fold":
      view.foldResults = value as boolean;
      ctx.redrawResults?.();
      return;
    case "foldLines":
      view.foldLines = value as number;
      ctx.redrawResults?.();
      return;
    case "foldSteps":
      view.foldSteps = value as number;
      return;
    case "statusStyle":
      ctx.deps.statusStyle = value as "rail" | "capsules" | "tiles" | "classic";
      ctx.updateStatus();
      return;
    case "statusWidgets":
      ctx.deps.statusWidgets = [...(value as string[])];
      ctx.updateStatus();
      return;
    case "showCostEstimate":
      ctx.deps.showCostEstimate = value as boolean;
      ctx.updateStatus();
      return;
    case "results":
      view.results = { ...DEFAULT_RESULT_VIEWS, ...((value as Record<string, ResultView>) ?? {}) };
      ctx.redrawResults?.();
      return;
    case "notify":
      ctx.deps.notify = value as "unfocused" | "always" | "off";
      return;
    case "compactionReserve":
      ctx.compaction.reserveTokens = value as number;
      ctx.updateStatus();
      return;
    case "compactionRatio":
      ctx.compaction.ratio = value as number;
      ctx.updateStatus();
      return;
    case "facts.repeats":
    case "facts.slow":
    case "facts.date":
      ctx.agent.configure({ facts: { ...ctx.agent.facts, [def.key.slice(6)]: value as boolean } });
      return;
    case "planReminder":
      ctx.agent.configure({ planReminder: value as number });
      return;
    case "plan":
      if (!ctx.tools.some((t) => t.name === "plan"))
        throw new Error(
          "the plan tool is not loaded in this session; enable it in Saved defaults and restart",
        );
      if (value) ctx.slots.disabledTools.delete("plan");
      else ctx.slots.disabledTools.add("plan");
      ctx.applyTools?.();
      return;
    case "tools.disable": {
      const plan = ctx.slots.disabledTools.has("plan");
      ctx.slots.disabledTools.clear();
      for (const name of (value as string[] | undefined) ?? []) ctx.slots.disabledTools.add(name);
      if (plan) ctx.slots.disabledTools.add("plan");
      ctx.applyTools?.();
      return;
    }
    case "toolPrompts":
    case "approve":
    case "compaction":
    case "compactionPrompt":
    case "compactionMaxTokens":
    case "compactionAcceptance":
    case "compactionTrigger":
    case "execution":
    case "steering":
      return applySlotValue(ctx, def.key, String(value));
    case "preservation":
      if (value === undefined) {
        delete ctx.compaction.preservation;
        ctx.slots.state.preservation = "";
        return;
      }
      return applySlotValue(ctx, def.key, String(value));
    case "effort":
      ctx.agent.setEffort(value as EffortLevel | undefined);
      ctx.updateStatus();
      return;
    default:
      return;
  }
}

export type SettingChange = { ok: boolean; message: string };

/** 先准备完整策略再替换八个组成项,避免组合只切换了一半。 */
export async function changeCompactionReference(
  ctx: TuiContext,
  values: Preset,
  scope: SetupScope,
): Promise<SettingChange> {
  try {
    const ensureIdle = () => {
      if (scope === "session" && ctx.agent.running)
        throw new Error(
          "This composition cannot change mid-turn. Wait, or press Esc to interrupt.",
        );
    };
    ensureIdle();
    const entries = Object.keys(DEFAULT_COMPACTION_SETTINGS).map((key) => {
      const def = settingDef(key);
      if (!def) throw new Error(`Unknown compaction setting: ${key}`);
      const value = getSetting(values, key);
      validate(def, value);
      return [key, value] as const;
    });
    const next = await buildCompaction(values, ctx.compaction.window);
    ensureIdle();
    if (scope === "defaults") {
      if (!ctx.deps.settings?.saveSettings)
        throw new Error("Saving this composition is not available here. Use This session.");
      await ctx.deps.settings.saveSettings(Object.fromEntries(entries));
    } else {
      delete ctx.compaction.preservation;
      Object.assign(ctx.compaction, next);
      for (const key of ["compaction", "compactionPrompt", "compactionMaxTokens", "preservation"])
        ctx.slots.state[key] = String(getSetting(values, key) ?? "");
      ctx.updateStatus();
    }
    for (const [key, value] of entries)
      ctx.log.append({
        type: "ext/event",
        at: now(),
        source: "setup",
        kind: "setting",
        payload: { key, value, scope },
      });
    if (scope === "session") ctx.persistSetup();
    return {
      ok: true,
      message:
        scope === "session"
          ? "Context composition applied. Used by the next compaction check; no request sent."
          : "Context composition saved for future starts. This session stays unchanged.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

function validate(def: SettingDef, value: unknown): void {
  if (def.key === "prompt.skills.sources") parseSkillSources(value);
  if (
    def.key === "prompt.skills.include" &&
    value !== "all" &&
    (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim()))
  )
    throw new Error("prompt.skills.include takes all or a list of skill names.");
  if (value === undefined) {
    if (def.builtin !== undefined)
      throw new Error(`${def.key} needs a value; choose its recommended value to reset it.`);
    return;
  }
  if (def.type === "bool" && typeof value !== "boolean")
    throw new Error(`${def.key} takes on or off`);
  if (def.type === "number") parseSetting(def, String(value));
  if (def.type === "enum") parseSetting(def, String(value));
  if (def.key === "preservation") parsePreservation(String(value));
  if (
    def.key === "statusWidgets" &&
    (!Array.isArray(value) || value.some((id) => !def.items?.includes(id)))
  )
    throw new Error("statusWidgets takes a list of registered status readings.");
}

/** session 只改运行态;defaults 先可靠落盘;both 保留已有打字命令的应用并保存语义。 */
export async function changeSetting(
  ctx: TuiContext,
  def: SettingDef,
  value: unknown,
  scope: SetupScope | "both",
): Promise<SettingChange> {
  try {
    validate(def, value);
    if (def.key === "compactionPrompt") await loadSummaryPrompt(String(value));
    const save = ctx.deps.settings?.saveSetting;
    if (scope === "defaults") {
      if (def.key === "compaction") validateCompactionName(String(value));
      if (!save)
        throw new Error(
          "Saving is not available here. Use This session to make a temporary change.",
        );
      await save(def.key, value);
      ctx.log.append({
        type: "ext/event",
        at: now(),
        source: "setup",
        kind: "setting",
        payload: { key: def.key, value, scope: "defaults" },
      });
      const layers = ctx.deps.settings?.settingLayers?.();
      const overridden = getSetting(layers?.preset, def.key) !== undefined;
      return {
        ok: true,
        message: `${def.key} → ${formatSetting(def, value)} · saved for future starts; this session unchanged${def.key === "compaction" ? " · strategy loads at startup" : ""}${overridden ? ` · preset ${layers?.presetName ?? ""} still overrides defaults` : ""}`,
      };
    }
    if (def.scope === "next start") {
      if (scope === "session") throw new Error(settingTiming(ctx, def, "session"));
      if (!save)
        throw new Error("This setting requires a restart, and saving is not available here.");
      await save(def.key, value);
      return { ok: true, message: describeChange(def, value, undefined, true) };
    }
    if (ctx.agent.running && (SLOT_SETTINGS.has(def.key) || def.key === "prompt.skills.sources"))
      throw new Error(settingTiming(ctx, def, "session"));
    await applySettingNow(ctx, def, value ?? def.builtin);
    ctx.log.append({
      type: "ext/event",
      at: now(),
      source: "setup",
      kind: "setting",
      payload: { key: def.key, value, scope: "session" },
    });
    ctx.persistSetup();
    if (scope === "both" && save) {
      try {
        await save(def.key, value);
      } catch (err) {
        return {
          ok: false,
          message: `${def.key} changed for this session, but was not saved: ${errorMessage(err)}. Retry saving in Saved defaults.`,
        };
      }
    }
    return {
      ok: true,
      message: `${def.key} → ${formatSetting(def, value)} · ${settingTiming(ctx, def, "session")}${scope === "both" ? (save ? " · saved to config" : " · not saved: no config here") : " · this session only"}`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export function parseTyped(arg: string): { def: SettingDef; value: unknown } | string {
  const [, key = "", rest] = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(arg) ?? [];
  const def = settingDef(key);
  if (!def) return `unknown setting ${key} · /settings lists them`;
  if (rest === undefined) return `usage: /settings ${def.key} <value> · ${def.note}`;
  try {
    return { def, value: parseSetting(def, rest) };
  } catch (err) {
    return errorMessage(err);
  }
}

export function describeChange(
  def: SettingDef,
  value: unknown,
  applied: string | undefined,
  saved: boolean,
): string {
  return [
    `${def.key} → ${formatSetting(def, value)}`,
    applied || (def.scope === "now" ? "in effect now" : "takes effect at the next start"),
    saved ? "saved to config" : "not saved: no config here",
  ].join(" · ");
}

export type { Preset };

export function captureSessionSetup(ctx: TuiContext): SessionSetup {
  const values = setupSnapshot(SETTINGS, (def) => effectiveSetting(ctx, def));
  values.extensions = [...(ctx.setupBase.extensions ?? [])];
  values.approval = structuredClone(ctx.approval.cfg);
  if (ctx.setupBase.systemPromptFile) values.systemPromptFile = ctx.setupBase.systemPromptFile;
  if (ctx.setupBase.appendSystemPromptFile)
    values.appendSystemPromptFile = ctx.setupBase.appendSystemPromptFile;
  return {
    values,
    tools: ctx.defs().map((tool) => tool.name),
    descriptions: structuredClone(ctx.slots.toolPrompts.descriptions ?? {}),
  };
}
