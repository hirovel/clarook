// 验证用户能完成的调整流程:作用域、真实请求、恢复、错误、窄屏与长列表。

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { SessionInputs } from "../cli/session-inputs.js";
import { restoreSessionSetup } from "../cli/session-setup.js";
import { renderStatusLayout } from "../cli/status-layout.js";
import { createTuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import {
  COMPACTION_REFERENCES,
  DEFAULT_COMPACTION_SETTINGS,
  summaryPrompt,
} from "../src/compaction-presets.js";
import type { Preset } from "../src/config.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { Message } from "../src/messages.js";
import { planTool } from "../src/plan.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { setSetting } from "../src/settings.js";
import { STATUS_WIDGETS } from "../src/status-bar.js";
import { defineTool } from "../src/tools.js";
import { testDirectory } from "./helpers/setup.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const tick = () => new Promise((r) => setTimeout(r, 5));
const DOWN = "\x1b[B",
  ENTER = "\r",
  ESC = "\x1b",
  TAB = "\t";
const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

function boot(over: Partial<TuiAppDeps> = {}, size = [120, 40]) {
  const saved: [string, unknown][] = [];
  let defaults: Preset = { foldSteps: 5 };
  const presets: { name: string; values: Preset }[] = [];
  const requests: string[][] = [];
  const provider: Provider = {
    model: "m",
    async complete(_messages, tools): Promise<AssistantTurn> {
      requests.push(tools.map((t) => t.name));
      return { text: "ok", toolCalls: [], stopReason: "end" };
    },
  };
  const term = new VirtualTerminal(size[0], size[1]);
  const log = new EventLog();
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echo, planTool],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "sys",
    foldSteps: 5,
    settings: {
      listModels: () => [],
      switchModel: () => {
        throw new Error("no");
      },
      setKey: () => {},
      setDefault: () => {},
      settingLayers: () => ({ defaults }),
      saveSetting: (key, value) => {
        saved.push([key, value]);
        defaults = setSetting(defaults, key, value);
      },
      saveSettings: (values) => {
        for (const [key, value] of Object.entries(values)) {
          saved.push([key, value]);
          defaults = setSetting(defaults, key, value);
        }
      },
      listPresets: () => presets,
      savePreset: (name, values) => {
        presets.push({ name, values });
      },
      usePreset: (name) => {
        defaults = presets.find((p) => p.name === name)?.values ?? {};
      },
    },
    onExit: () => {},
    ...over,
  });
  const doc = () => app.lines(size[0]).map(stripAnsi).join("\n");
  const menu = () => app.dialogLines().map(stripAnsi).join("\n");
  return { app, term, doc, menu, saved, presets, requests, log, defaults: () => defaults };
}

describe("Agent setup", () => {
  it("参考组合只修改压缩设置，预览零请求，单项调整控制实际摘要并保存恢复", async () => {
    const calls: { messages: Message[]; maxTokens?: number }[] = [];
    const provider: Provider = {
      model: "m",
      async complete(messages, _tools, opts) {
        calls.push({
          messages: structuredClone(messages),
          ...(opts?.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
        });
        return { text: "Summary ready.", toolCalls: [], stopReason: "end" };
      },
    };
    const { app, menu, defaults, log } = boot({ provider });
    try {
      app.setDraft("Keep my working draft.");
      await app.command("/settings compaction");
      app.dialogInput("\x1b[A");
      app.dialogInput(ENTER);
      expect(menu()).toContain("Pi reference");
      expect(calls).toEqual([]);
      app.dialogInput(ENTER);
      await tick();
      for (const [key, value] of Object.entries(DEFAULT_COMPACTION_SETTINGS))
        expect(app.setup().values[key as keyof Preset]).toEqual(value);
      expect(app.agent.provider.model).toBe("m");
      expect(app.setup().tools).toEqual(["echo", "plan"]);
      expect(defaults()).toEqual({ foldSteps: 5 });
      expect(app.draft()).toBe("Keep my working draft.");
      app.dialogInput(TAB);
      app.dialogInput(ENTER);
      app.dialogInput(DOWN);
      app.dialogInput(ENTER);
      await tick();
      const codex = COMPACTION_REFERENCES.find((reference) => reference.id === "codex");
      if (!codex) throw new Error("Codex reference is missing");
      for (const [key, value] of Object.entries(codex.values))
        expect(defaults()[key as keyof Preset]).toEqual(value);
      expect(defaults().foldSteps).toBe(5);
      expect(app.setup().values.compactionPrompt).toBe("pi");
      expect(calls).toEqual([]);
      await app.command("/settings compactionPrompt minimal");
      await app.command("/settings compactionMaxTokens 222");
      await app.command("/set preservation tokens 1");
      expect(app.setup().values.compactionPrompt).toBe("minimal");
      expect(restoreSessionSetup(log.events, {}).setup.values.compactionPrompt).toBe("minimal");
      await app.command("/settings compaction");
      app.dialogInput("\x1b[A");
      expect(menu()).toContain("Current: Custom");
      app.dialogInput(ESC);
      app.dialogInput(ESC);
      await app.submit("Keep this first request.");
      await app.submit("Record this subsequent request and verified work.");
      await app.command("/compact");
      expect(calls).toHaveLength(3);
      expect(calls.at(-1)?.maxTokens).toBe(222);
      expect(
        calls
          .at(-1)
          ?.messages.some((message) => message.content.includes(summaryPrompt("minimal"))),
      ).toBe(true);
    } finally {
      app.stop();
    }
  });

  it("运行中不能部分切换参考组合，保存默认值不影响当前任务", async () => {
    let finish: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { app, menu, defaults, log } = boot({
      provider: {
        model: "m",
        async complete() {
          await waiting;
          return { text: "Finished.", toolCalls: [], stopReason: "end" };
        },
      },
    });
    const run = app.submit("Work in progress.");
    try {
      await tick();
      app.setDraft("Unsent next request.");
      const before = app.setup().values;
      const changes = log.events.filter((event) => event.type === "ext/event").length;
      await app.command("/settings compaction");
      app.dialogInput("\x1b[A");
      app.dialogInput(ENTER);
      app.dialogInput(ENTER);
      await tick();
      expect(menu()).toContain("cannot change mid-turn");
      expect(app.setup().values).toEqual(before);
      expect(log.events.filter((event) => event.type === "ext/event")).toHaveLength(changes);
      expect(app.draft()).toBe("Unsent next request.");
      app.dialogInput(ESC);
      app.dialogInput(TAB);
      app.dialogInput(ENTER);
      app.dialogInput(ENTER);
      await tick();
      expect(defaults().compactionPrompt).toBe("pi");
      expect(app.setup().values).toEqual(before);
    } finally {
      finish?.();
      await run;
      app.stop();
    }
  });

  it("窄屏参考组合模板可完整分页，阅读返回保留候选和草稿", async () => {
    const { app, menu, saved, requests, term } = boot({}, [60, 24]);
    try {
      app.setDraft("Draft stays outside setup.");
      await app.command("/settings compaction");
      app.dialogInput("\x1b[A");
      app.dialogInput(ENTER);
      app.dialogInput("\x1b[C");
      app.dialogInput(ENTER);
      const pages: string[] = [];
      for (let page = 0; page < 25; page++) {
        pages.push(menu());
        expect(app.dialogLines().length).toBeLessThanOrEqual(22);
        expect(app.dialogLines().every((line) => stripAnsi(line).length <= 60)).toBe(true);
        app.dialogInput("\x1b[6~");
      }
      const text = pages.join("\n").replace(/\s+/g, " ");
      expect(text).toContain("Prompt sent to summarizer");
      expect(text).toContain("Summary format (model instructions)");
      expect(text).toContain("## Critical Context");
      expect(text).toContain(COMPACTION_REFERENCES[0]?.differences[0]);
      app.dialogInput(ESC);
      expect(menu()).toMatch(/›\s+Pi reference/);
      app.tui.renderNow(true);
      expect((await term.screen()).slice(-24).join("\n")).toContain("Esc back");
      app.dialogInput(ESC);
      app.dialogInput(ESC);
      app.dialogInput(ESC);
      expect(app.draft()).toBe("Draft stays outside setup.");
      expect(saved).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      app.stop();
    }
  });

  it("窄状态栏保留全部已选读数，隐藏读数仍保留保存故障和恢复入口", async () => {
    const lines = renderStatusLayout(
      "rail",
      STATUS_WIDGETS.map((widget) => widget.id),
      {
        context: "Context ~24k/128k",
        cache: "last cache 73%",
        model: "model deepseek-flash",
        effort: "effort Auto (omitted)",
        compaction: "compact manual",
      },
      28,
    ).map(stripAnsi);
    expect(lines.join("\n")).toContain("Context ~24k/128k");
    expect(lines.join("\n")).toContain("last cache 73%");
    expect(lines.join("\n")).toContain("model deepseek-flash");
    expect(lines.join("\n")).toContain("effort Auto (omitted)");
    expect(lines.join("\n")).toContain("compact manual");
    expect(lines.every((line) => line.length <= 28)).toBe(true);
    const inputs = new SessionInputs(join(tmpdir(), `${randomUUID()}.jsonl`), false);
    const { app, term } = boot({ inputs, statusWidgets: [] }, [24, 24]);
    try {
      inputs.error = "Local save failed";
      app.tui.renderNow(true);
      const screen = (await term.screen()).join("\n").replace(/\s+/g, " ");
      expect(screen).toContain("Inputs not saved");
      expect(screen).toContain("/session inputs");
      expect(screen).not.toContain("model m");
    } finally {
      app.stop();
    }
  });
  it("状态栏样式可预览，内容在次级菜单勾选并立即生效", async () => {
    const { app, term, menu, doc, saved } = boot();
    app.setDraft("bar-location-check");
    app.tui.renderNow(true);
    const screen = (await term.screen()).join("\n");
    expect(screen.indexOf("bar-location-check")).toBeLessThan(screen.indexOf("Ready"));
    expect(doc().indexOf("bar-location-check")).toBeLessThan(doc().indexOf("Ready"));
    await app.command("/settings statusStyle");
    app.dialogInput(ENTER);
    app.dialogInput(DOWN);
    app.dialogInput(DOWN);
    expect(menu()).toContain("Live preview");
    expect(menu()).toContain("Instrument tiles");
    expect(menu()).toContain("▏ model m");
    app.dialogInput(ENTER);
    await tick();
    expect(doc()).toContain("▏ model m");
    app.dialogInput(ESC);
    app.dialogInput(ESC);

    await app.command("/settings statusWidgets");
    app.dialogInput(ENTER);
    expect(menu()).toContain("Context");
    expect(menu()).toContain("Shown [x]");
    app.dialogInput(ENTER);
    await tick();
    expect(doc()).not.toContain("Context · no requests yet");
    expect(doc()).toContain("▏ model m");
    expect(saved).toEqual([]);
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    await app.command("/settings statusStyle");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput(DOWN);
    app.dialogInput(DOWN);
    app.dialogInput(DOWN);
    app.dialogInput(ENTER);
    await tick();
    expect(saved).toEqual([["statusStyle", "classic"]]);
    expect(doc()).toContain("▏ model m");
    app.stop();
  });
  it("同一模型入口区分当前切换与默认值保存,保存默认值不会创建供应商", async () => {
    let chosen = 0;
    let defaults: Preset = {};
    const cuts: number[] = [];
    const history: AgentEvent[] = [
      { type: "session/start", at: "", model: "m", system: "" },
      { type: "user/message", at: "", text: "x".repeat(80000) },
      {
        type: "assistant/message",
        at: "",
        text: "x".repeat(68000),
        toolCalls: [],
        stopReason: "end",
      },
    ];
    const { app, menu, log } = boot({
      compaction: {
        window: 100000,
        strategy: async (input) => {
          cuts.push(input.preservation?.(history) ?? -1);
          return null;
        },
      },
      settings: {
        listModels: () => ["p/m", "p/other"],
        defaultModel: () => "p/m",
        switchModel: (name) => {
          chosen++;
          return {
            provider: {
              model: name.split("/")[1] as string,
              async complete() {
                return { text: "ok", toolCalls: [], stopReason: "end" };
              },
            },
            providerName: "p",
            model: name.split("/")[1] as string,
            contextWindow: 64000,
          };
        },
        setKey: () => {},
        setDefault: () => {},
        settingLayers: () => ({ defaults }),
        saveSetting: (key, value) => {
          defaults = setSetting(defaults, key, value);
        },
      },
    });
    await app.command("/settings preservation auto");
    await app.command("/compact");
    expect(cuts).toEqual([2]);
    await app.command("/settings model");
    app.dialogInput(ENTER);
    app.dialogInput("3");
    app.dialogInput(ENTER);
    await tick();
    expect(chosen).toBe(1);
    expect(app.agent.provider.model).toBe("other");
    expect(log.events.some((e) => e.type === "session/model" && e.model === "other")).toBe(true);
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("2");
    app.dialogInput(ENTER);
    await tick();
    expect(chosen).toBe(1);
    expect(defaults.model).toBe("p/m");
    expect(menu()).toContain("this session unchanged");
    await app.command("/compact");
    expect(cuts).toEqual([2, 3]);
    app.stop();
  });
  it("按组成导航,搜索后可以修改当前会话,不偷偷保存", async () => {
    const { app, menu, saved } = boot();
    await app.command("/settings");
    expect(menu()).toContain("Agent setup");
    for (const name of [
      "Model",
      "Instructions & memory",
      "Tools & delegation",
      "Context management",
      "Execution & control",
      "Save as preset",
    ])
      expect(menu()).toContain(name);
    expect(menu()).toContain("p/m · effort Model default");
    expect(menu()).toContain("Skills Manual · memory Off");
    const unchanged = menu();
    for (const key of ["e", "E", "i", "I", "r", "R"]) app.dialogInput(key);
    expect(menu()).toBe(unchanged);
    // 首页摘要和详情共用作用域,切到保存值不能继续显示运行值。
    app.dialogInput(TAB);
    expect(menu()).toContain("Configured default · effort Model default");
    expect(menu()).not.toContain("p/m · effort");
    app.dialogInput(TAB);
    app.dialogInput("/");
    app.dialogInput("foldLines");
    expect(menu()).toContain("Output preview lines");
    app.dialogInput(ENTER);
    app.dialogInput("\x1b[C");
    app.dialogInput(ENTER);
    app.dialogInput("\x15");
    app.dialogInput("9");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("this session only");
    expect(saved).toEqual([]);
    expect(menu()).toContain("9");
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    expect(app.dialogLines()).toEqual([]);
    app.stop();
  });

  it("保存默认值不改当前会话;重新打开仍区分实际值与保存值", async () => {
    const { app, menu, saved, log, defaults } = boot();
    await app.command("/settings foldSteps");
    expect(menu()).toContain("matches config");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("5");
    app.dialogInput(ENTER);
    await tick();
    expect(saved).toEqual([["foldSteps", 10]]);
    expect(menu()).toContain("this session unchanged");
    app.dialogInput(TAB);
    expect(menu()).toMatch(/Expanded recent steps\s+5/);
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    await app.command("/settings foldSteps");
    expect(menu()).toMatch(/Expanded recent steps\s+5/);
    expect(menu()).toContain("Current: 5");
    expect(menu()).toContain("Saved default: 10");
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    await app.command("/settings prompt.skills.sources");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput(ENTER);
    await tick();
    expect(saved.at(-1)?.[0]).toBe("prompt.skills.sources");
    expect((saved.at(-1)?.[1] as Record<string, string> | undefined)?.["user-clarook"]).toBe("off");
    expect(app.setup().values.prompt?.skills?.sources?.["user-clarook"]).toBe("on");
    await app.command("/settings compactionRatio");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("2");
    app.dialogInput(ENTER);
    await tick();
    expect(defaults().compactionRatio).toBe(0.8);
    expect(app.setup().values.compactionRatio).toBe(0);
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("2");
    app.dialogInput(ENTER);
    await tick();
    expect(app.setup().values.compactionRatio).toBe(0.8);
    expect(restoreSessionSetup(log.events, {}).setup.values.compactionRatio).toBe(0.8);
    app.stop();
  });

  it("工具显示 Enabled/Disabled,开关改变下一轮实际发送的工具,并保留未知工具配置", async () => {
    const { app, menu, requests } = boot({ disabledTools: ["missing-mcp-tool"] });
    await app.command("/settings tools.disable");
    app.dialogInput(ENTER);
    expect(menu()).toMatch(/echo\s+Enabled/);
    expect(menu()).toMatch(/missing-mcp-tool\s+Disabled/);
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toMatch(/echo\s+Disabled/);
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    await app.submit("hi");
    expect(requests[0]).not.toContain("echo");
    expect(requests[0]).toContain("plan");
    app.stop();
  });

  it("自定义值报错留在编辑器,推荐值恢复有明确预览且可以取消", async () => {
    const { app, menu } = boot();
    await app.command("/settings planReminder");
    app.dialogInput(ENTER);
    app.dialogInput("\x1b[C");
    app.dialogInput(ENTER);
    app.dialogInput("\x15");
    app.dialogInput("many");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("takes a whole number");
    app.dialogInput("\x15");
    app.dialogInput("12");
    app.dialogInput(ENTER);
    await tick();
    expect(app.agent.planReminder).toBe(12);
    app.dialogInput("\x1b[D");
    app.dialogInput(ENTER);
    expect(menu()).toContain("Restore recommended value");
    app.dialogInput(ESC);
    expect(app.agent.planReminder).toBe(12);
    app.dialogInput("\x1b[D");
    app.dialogInput(ENTER);
    app.dialogInput(ENTER);
    await tick();
    expect(app.agent.planReminder).toBe(0);
    app.stop();
  });

  it("需要重启的设置不冒充当前已生效;空段列表可以真的保存为空", async () => {
    const { app, menu, saved } = boot();
    await app.command("/settings prompt.sections");
    app.dialogInput(ENTER);
    expect(menu()).toContain("Requires a restart");
    expect(saved).toEqual([]);
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    for (let i = 0; i < 6; i++) {
      app.dialogInput(ENTER);
      await tick();
      app.dialogInput(DOWN);
    }
    expect(saved.at(-1)).toEqual(["prompt.sections", []]);
    app.dialogInput(ESC);
    app.dialogInput(TAB);
    expect(menu()).toMatch(/Prompt sections\s+6 selected/);
    app.stop();
  });

  it("运行中策略切换失败不会把拒绝的值保存;界面设置仍可改", async () => {
    let finish: ((turn: AssistantTurn) => void) | undefined;
    const provider: Provider = {
      model: "m",
      complete: () =>
        new Promise((r) => {
          finish = r;
        }),
    };
    const { app, doc, saved } = boot({ provider });
    const pending = app.submit("wait");
    await tick();
    await app.command("/settings execution parallel");
    expect(doc()).toContain("cannot change mid-turn");
    expect(saved).toEqual([]);
    await app.command("/settings foldLines 9");
    expect(saved).toEqual([["foldLines", 9]]);
    finish?.({ text: "ok", toolCalls: [], stopReason: "end" });
    await pending;
    app.stop();
  });

  it("持久化失败有恢复说明,保留编辑状态,不关闭工作台", async () => {
    for (const failure of [new Error("disk full"), "save rejected", null]) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      const { app, menu, doc } = boot({
        settings: {
          listModels: () => [],
          switchModel: () => {
            throw new Error("unused");
          },
          setKey: () => {},
          setDefault: () => {},
          saveSetting: () => {
            throw failure;
          },
        },
      });
      try {
        await app.command("/settings fold");
        app.dialogInput(TAB);
        app.dialogInput(ENTER);
        app.dialogInput("2");
        app.dialogInput(ENTER);
        await tick();
        expect(menu()).toContain(reason);
        expect(menu()).toContain("Fold tool output");
        expect(menu()).toContain("Enter apply");
        app.dialogInput(ESC);
        await app.command("/settings execution parallel");
        expect(app.agent.slots.execution).toBe("parallel");
        expect(app.setup().values.execution).toBe("parallel");
        expect(doc()).toContain(`changed for this session, but was not saved: ${reason}`);
      } finally {
        app.stop();
      }
    }
  });

  it("方案保存包含当前注册设置与模型,加载先预览再修改默认值", async () => {
    const { app, menu, presets } = boot();
    await app.command("/settings");
    app.dialogInput("8");
    app.dialogInput(ENTER);
    app.dialogInput("my-agent");
    app.dialogInput(ENTER);
    await tick();
    expect(presets[0]?.name).toBe("my-agent");
    expect(presets[0]?.values.model).toBe("p/m");
    expect(presets[0]?.values.planReminder).toBe(0);
    app.dialogInput("9");
    app.dialogInput(ENTER);
    app.dialogInput(DOWN);
    app.dialogInput(ENTER);
    expect(menu()).toContain("Load my-agent");
    expect(menu()).toContain("Use for saved defaults");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("my-agent saved as defaults");
    expect(menu()).toContain("[Saved defaults]");
    app.stop();
  });

  it("窄终端与长工具列表:视口有边界,选中最后一项仍可见且可操作", async () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({
      ...echo,
      name: `tool_${String(i).padStart(2, "0")}`,
    }));
    const { app, menu, term, saved } = boot({ tools }, [60, 24]);
    app.setDraft("unrelated draft");
    await app.command("/settings");
    // 分隔线不占导航项;翻页、跳到末尾及返回仍指向正确的模块或操作。
    expect(menu()).toContain("1–2 of 9");
    app.dialogInput("\x1b[6~");
    expect(menu()).toMatch(/›\s+Tools & delegation/);
    app.dialogInput(ENTER);
    expect(menu()).toContain("Agent setup / Tools & delegation");
    app.dialogInput(ESC);
    expect(menu()).toMatch(/›\s+Tools & delegation/);
    app.dialogInput("\x1b[5~");
    expect(menu()).toMatch(/›\s+Model/);
    app.dialogInput("\x1b[F");
    expect(menu()).toMatch(/›\s+Load preset/);
    expect(app.dialogLines().length).toBeLessThanOrEqual(22);
    app.dialogInput(ENTER);
    expect(menu()).toContain("Recommended");
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    expect(app.draft()).toBe("unrelated draft");
    await app.command("/settings tools.disable");
    app.dialogInput(ENTER);
    app.dialogInput("\x1b[F");
    expect(menu()).toMatch(/›\s+tool_39/);
    expect(menu()).toContain("of 40");
    expect(app.dialogLines().length).toBeLessThanOrEqual(22);
    expect(app.dialogLines().every((line) => stripAnsi(line).length <= 60)).toBe(true);
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toMatch(/tool_39\s+Disabled/);
    // 经过真实 TUI→ANSI→xterm 渲染链后,底部操作提示仍在可见窗口。
    app.tui.requestRender();
    await expect
      .poll(async () => (await term.screen()).slice(-24).join("\n"))
      .toContain("Esc back");
    // 选项详情不能丢掉光标候选,返回时仍可确认同一项;阅读本身不修改设置。
    await app.command("/settings compaction");
    app.dialogInput(ENTER);
    app.dialogInput(DOWN);
    expect(menu()).toContain("No model call.");
    expect(menu()).toContain("Current: Model summary");
    expect(menu()).toContain("Saved default: Model summary");
    app.dialogInput("\x1b[D");
    app.dialogInput(ENTER);
    expect(menu()).toContain("Clear tool results");
    expect(menu()).toContain("No model call.");
    app.dialogInput("\x1b[6~");
    app.dialogInput(ESC);
    expect(menu()).toMatch(/›\s+Clear tool results/);
    expect(menu()).toContain("Current: Model summary");
    expect(saved).toEqual([]);
    app.dialogInput(ENTER);
    await tick();
    app.dialogInput("\x1b[C");
    app.dialogInput(ENTER);
    expect(menu()).toContain("Current: Clear tool results (clear)");
    expect(menu()).toContain("Saved default: Model summary (llm)");
    await app.command("/settings prompt.skills.sources");
    app.dialogInput(ENTER);
    app.dialogInput("\x1b[F");
    app.dialogInput(ENTER);
    const longPath = `C:/skills/${"long-directory/".repeat(8)}visible-tail`;
    app.setDraft("unrelated draft");
    app.dialogInput(`\x1b[200~${longPath}\x1b[201~`);
    expect(menu()).toContain("visible-tail");
    expect(menu()).toContain("visible-tail▏");
    expect(app.dialogLines().every((line) => stripAnsi(line).length <= 60)).toBe(true);
    app.tui.requestRender();
    await expect
      .poll(async () => (await term.screen()).slice(-24).join("\n"))
      .toContain("visible-tail");
    app.dialogInput(ESC);
    expect(menu()).toMatch(/›\s+Add directory/);
    expect(app.draft()).toBe("unrelated draft");
    expect(saved).toEqual([]);
    app.stop();
  });

  it("打字入口保留应用并保存语义,错误与恢复都明确", async () => {
    const { app, doc, saved, log, defaults, menu } = boot();
    await app.command("/settings foldLines 9");
    expect(saved.at(-1)).toEqual(["foldLines", 9]);
    await app.command("/settings screen main");
    expect(doc()).toContain("screen → main · takes effect at the next start");
    await app.command("/settings checkUpdates off");
    expect(saved.at(-1)).toEqual(["checkUpdates", false]);
    app.setDraft("Keep this unsent draft.");
    await app.command("/help update");
    expect(doc()).toContain("npm install -g clarook@latest");
    expect(app.draft()).toBe("Keep this unsent draft.");
    await app.command("/settings nope 1");
    expect(doc()).toContain("unknown setting nope");
    expect(log.events.some((e) => e.type === "ext/event" && e.source === "setup")).toBe(true);
    const savedBeforeFailure = [...saved];
    const eventsBeforeFailure = log.events.length;
    await app.command("/settings model p/unavailable");
    await app.command("/settings compaction ./missing-setting-strategy.mjs");
    await app.command("/settings compactionPrompt constructor");
    expect(saved).toEqual(savedBeforeFailure);
    expect(app.agent.provider.model).toBe("m");
    expect(app.setup().values.compaction).toBe("llm");
    expect(log.events.slice(eventsBeforeFailure).some((e) => e.type === "ext/event")).toBe(false);
    await app.command("/settings execution parallel");
    expect(app.agent.slots.execution).toBe("parallel");
    expect(saved.at(-1)).toEqual(["execution", "parallel"]);
    await app.command("/set execution sequential");
    expect(app.agent.slots.execution).toBe("sequential");
    expect(saved.at(-1)).toEqual(["execution", "parallel"]);
    await app.command('/settings prompt.skills.sources {"./custom  skills":"on"}');
    expect(saved.at(-1)).toEqual(["prompt.skills.sources", { "./custom  skills": "on" }]);
    await app.command("/set compaction clear");
    const beforeInvalidPrompt = [...saved];
    await app.command("/settings compactionPrompt invalid-template");
    expect(saved).toEqual(beforeInvalidPrompt);
    expect(app.setup().values.compactionPrompt).toBe("pi");
    expect(
      restoreSessionSetup(log.events, DEFAULT_COMPACTION_SETTINGS).setup.values.compactionPrompt,
    ).toBe("pi");
    await app.command("/set compaction llm");
    expect(app.setup().values.compaction).toBe("llm");

    await app.command("/settings compaction");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("\x1b[C");
    app.dialogInput(ENTER);
    app.dialogInput("\x15");
    app.dialogInput("not-a-strategy");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("unknown compaction strategy");
    expect(saved).toEqual(beforeInvalidPrompt);
    const strategyPath = join(testDirectory("setup-strategy-"), "deferred.mjs");
    writeFileSync(strategyPath, 'throw new Error("must not execute during save");');
    app.dialogInput("\x15");
    app.dialogInput(strategyPath);
    app.dialogInput(ENTER);
    await tick();
    expect(defaults().compaction).toBe(strategyPath);
    expect(app.setup().values.compaction).toBe("llm");
    expect(menu()).toContain("strategy loads at startup");

    defaults().compactionPrompt = "constructor";
    await app.command("/settings compactionPrompt");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    expect(menu()).toContain("constructor");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("Unknown summary template");
    app.stop();
  });
});
