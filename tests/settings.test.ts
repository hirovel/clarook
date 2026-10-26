// 开关登记表:配置模板的 defaults 就是它;命令行解析认得表里的每个键(防失步);打字形态与显示;来源判定。
import { describe, expect, it } from "vitest";
import { applyPreset, parseCommonArgs } from "../cli/args.js";
import { CONFIG_TEMPLATE, type KernelConfig, type Preset } from "../src/config.js";
import {
  defaultPreset,
  formatSetting,
  getSetting,
  parseSetting,
  SETTINGS,
  setSetting,
  settingDef,
  settingSource,
} from "../src/settings.js";

const config = (defaults: Preset): KernelConfig => ({
  default: "m",
  providers: { p: { protocol: "openai", baseUrl: "http://x", models: ["m"] } },
  defaults,
});

describe("开关登记表", () => {
  it("模板的 defaults 从表生成;每个键唯一;每组都有开关", () => {
    expect(CONFIG_TEMPLATE.defaults).toEqual(defaultPreset());
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(getSetting(defaultPreset(), "facts.repeats")).toBe(true);
    expect(getSetting(defaultPreset(), "prompt.skills.load")).toBe("read");
    expect(getSetting(defaultPreset(), "tools.disable")).toBeUndefined();
  });

  it("命令行解析认得表里的每个键:写进 defaults 的非缺省值都到了参数里", () => {
    // 每个键给一个与内置不同的值,经 applyPreset 后必须能在 CommonArgs 里找到。
    const probe: Record<string, unknown> = {
      screen: "main",
      fold: false,
      foldLines: 7,
      foldSteps: 9,
      statusStyle: "tiles",
      statusWidgets: ["model", "queue"],
      showCostEstimate: true,
      results: { bash: "all" },
      compactionReserve: 12345,
      compactionRatio: 0.8,
      compactionPrompt: "minimal",
      compactionMaxTokens: 0,
      compactionAcceptance: "smaller",
      "facts.repeats": false,
      "facts.slow": false,
      "facts.date": false,
      plan: false,
      planReminder: 3,
      "prompt.sections": ["role", "env"],
      "prompt.instructionsAs": "user",
      "prompt.memory": true,
      "prompt.skills.mode": "auto",
      "prompt.skills.include": ["review"],
      "prompt.skills.load": "tool",
      "prompt.skills.sources": { "user-clarook": "off", "./custom skills": "on" },

      "tools.disable": ["bash"],
      mcpReconnect: ["browser"],
      saveInputs: false,
      toolPrompts: "rules",
      subagent: true,
      maxSteps: 42,
      approve: "ask",
      compaction: "clear",
      compactionTrigger: "manual",
      preservation: "tokens 5000",
      execution: "parallel",
      steering: "turn",
      notify: "off",
      checkUpdates: false,
      effort: "high",
      model: "p/m",
    };
    for (const s of SETTINGS) expect(probe, `probe value for ${s.key}`).toHaveProperty(s.key);
    let defaults: Preset = {};
    for (const [k, v] of Object.entries(probe)) defaults = setSetting(defaults, k, v);
    const args = applyPreset(parseCommonArgs([]), config(defaults));
    const seen: Record<string, unknown> = {
      screen: args.screen,
      fold: args.fold,
      foldLines: args.foldLines,
      foldSteps: args.foldSteps,
      statusStyle: args.statusStyle,
      statusWidgets: args.statusWidgets,
      showCostEstimate: args.showCostEstimate,
      results: args.results,
      compactionReserve: args.compactionReserve,
      compactionRatio: args.compactionRatio,
      compactionPrompt: args.compactionPrompt,
      compactionMaxTokens: args.compactionMaxTokens,
      compactionAcceptance: args.compactionAcceptance,
      "facts.repeats": args.facts?.repeats,
      "facts.slow": args.facts?.slow,
      "facts.date": args.facts?.date,
      plan: args.plan,
      planReminder: args.planReminder,
      "prompt.sections": args.promptSections,
      "prompt.instructionsAs": args.instructionsAs,
      "prompt.memory": args.memory,
      "prompt.skills.mode": args.skillsMode,
      "prompt.skills.include": args.skillsInclude,
      "prompt.skills.load": args.skillsLoad,
      "prompt.skills.sources": args.skillsSources,

      "tools.disable": args.disabledTools,
      mcpReconnect: args.mcpReconnect,
      saveInputs: args.saveInputs,
      toolPrompts: args.toolPrompts,
      subagent: args.subagent,
      maxSteps: args.maxSteps,
      approve: args.approve,
      compaction: args.compaction,
      compactionTrigger: args.compactionTrigger,
      preservation: args.preservation,
      execution: args.execution,
      steering: args.steering,
      notify: args.notify,
      checkUpdates: args.checkUpdates,
      effort: args.effort,
      model: args.model,
    };
    for (const s of SETTINGS) expect(seen[s.key], s.key).toEqual(probe[s.key]);
    expect(
      applyPreset(parseCommonArgs(["--hide-cost-estimate"]), config({ showCostEstimate: true }))
        .showCostEstimate,
    ).toBe(false);
    expect(
      applyPreset(parseCommonArgs(["--no-check-updates"]), config({ checkUpdates: true }))
        .checkUpdates,
    ).toBe(false);
    expect(parseCommonArgs(["--check-updates"]).checkUpdates).toBe(true);
    expect(
      applyPreset(parseCommonArgs(["--compaction-ratio", "0"]), config({ compactionRatio: 0.8 }))
        .compactionRatio,
    ).toBe(0);
    expect(parseCommonArgs(["--compaction-ratio", "0.65"]).compactionRatio).toBe(0.65);
    expect(
      applyPreset(
        parseCommonArgs([
          "--compaction-prompt",
          "codex",
          "--compaction-max-tokens",
          "0",
          "--compaction-acceptance",
          "complete",
        ]),
        config({
          compactionPrompt: "zcode",
          compactionMaxTokens: 20000,
          compactionAcceptance: "reduced",
        }),
      ),
    ).toMatchObject({
      compactionPrompt: "codex",
      compactionMaxTokens: 0,
      compactionAcceptance: "complete",
    });
    for (const value of [-0.1, 1, Number.NaN])
      expect(() => applyPreset(parseCommonArgs([]), config({ compactionRatio: value }))).toThrow(
        "compactionRatio",
      );
  });

  it("按路径读写:写 undefined 删项,空对象一并删;不改原对象", () => {
    const a: Preset = { facts: { repeats: true } };
    const b = setSetting(a, "facts.slow", false);
    expect(b).toEqual({ facts: { repeats: true, slow: false } });
    expect(a).toEqual({ facts: { repeats: true } });
    const c = setSetting(setSetting(b, "facts.repeats", undefined), "facts.slow", undefined);
    expect(c).toEqual({});
    expect(getSetting({ prompt: { skills: { load: "tool" } } }, "prompt.skills.load")).toBe("tool");
    expect(getSetting({}, "prompt.skills.load")).toBeUndefined();
  });

  it("打字形态 → 值,值 → 显示;错值的话是给人看的一句", () => {
    const def = (k: string) => settingDef(k) as NonNullable<ReturnType<typeof settingDef>>;
    expect(parseSetting(def("fold"), "off")).toBe(false);
    expect(parseSetting(def("foldSteps"), "12")).toBe(12);
    expect(parseSetting(def("compactionRatio"), "0.8")).toBe(0.8);
    for (const bad of ["-0.1", "1", "many", "none", ""])
      expect(() => parseSetting(def("compactionRatio"), bad)).toThrow("compactionRatio");
    expect(parseSetting(def("maxSteps"), "none")).toBeUndefined();
    expect(parseSetting(def("notify"), "always")).toBe("always");
    expect(parseSetting(def("results"), "read head bash all")).toEqual({
      read: "head",
      bash: "all",
    });
    expect(parseSetting(def("prompt.sections"), "role,env")).toEqual(["role", "env"]);
    expect(parseSetting(def("tools.disable"), "bash fetch")).toEqual(["bash", "fetch"]);
    expect(
      parseSetting(def("prompt.skills.sources"), '{"./custom  skills":"on","user-clarook":"off"}'),
    ).toEqual({ "./custom  skills": "on", "user-clarook": "off" });
    for (const bad of ["[]", "null", '{"":"on"}', '{"./skills":true}'])
      expect(() => parseSetting(def("prompt.skills.sources"), bad)).toThrow();
    expect(() => parseSetting(def("foldSteps"), "many")).toThrow("whole number");
    expect(() => parseSetting(def("notify"), "loud")).toThrow("unfocused · always · off");
    expect(() => parseSetting(def("prompt.sections"), "role,nope")).toThrow("nope is not one of");
    expect(() => parseSetting(def("results"), "read")).toThrow("pairs");
    expect(formatSetting(def("fold"), false)).toBe("off");
    expect(formatSetting(def("tools.disable"), undefined)).toBe("none");
    expect(formatSetting(def("results"), { read: "count", bash: "tail", edit: "count" })).toBe(
      "read count · bash tail · 1 more",
    );
    expect(formatSetting(def("prompt.sections"), ["role", "env"])).toBe("role · env");
  });

  it("来源:预设 > 配置 > 内置;都不等就是命令行", () => {
    const def = settingDef("foldSteps") as NonNullable<ReturnType<typeof settingDef>>;
    const layers = { defaults: { foldSteps: 5 }, preset: { foldSteps: 7 }, presetName: "long" };
    expect(settingSource(def, 7, layers)).toBe("preset long");
    expect(settingSource(def, 5, layers)).toBe("config");
    expect(settingSource(def, 3, {})).toBe("built-in");
    expect(settingSource(def, 9, layers)).toBe("flag");
  });
});
