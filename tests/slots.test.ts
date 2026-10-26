// 会话中切换策略槽:命令改变下一次 turn 的行为,每次切换记 session/slot,/slots 显示当前。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { parsePreservation } from "../cli/args.js";
import { recordSessionSetup, restoreSessionSetup } from "../cli/session-setup.js";
import { buildCompaction } from "../cli/strategies.js";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "m",
    async complete() {
      return turns[i++] ?? { text: "done", toolCalls: [], stopReason: "end" };
    },
  };
}

function boot(provider: Provider) {
  const log = new EventLog();
  const slow = defineTool({
    name: "slow",
    description: "",
    parameters: Type.Object({}),
    concurrency: "parallel",
    async execute() {
      await sleep(5);
      return "ok";
    },
  });
  const app = createTuiApp({
    terminal: new VirtualTerminal(110, 30),
    log,
    provider,
    tools: [slow],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "s",
    compactionName: "llm",
    onExit: () => {},
  });
  const text = () => app.lines(110).map(plain).join("\n");
  return { app, log, text };
}

describe("/slots 与切换命令", () => {
  it("/slots 列出缺省;/execution parallel 记事件并让下一 turn 并行;/steering turn 让插话等到 turn 边界", async () => {
    const two = [
      { id: "a", name: "slow", args: {} },
      { id: "b", name: "slow", args: {} },
    ];
    const { app, log, text } = boot(
      scripted([
        { text: "", toolCalls: two, stopReason: "tool" },
        { text: "first", toolCalls: [], stopReason: "end" },
        { text: "", toolCalls: two, stopReason: "tool" },
        { text: "second", toolCalls: [], stopReason: "end" },
      ]),
    );
    await app.command("/inspect slots");
    let doc = text();
    expect(doc).toContain("execution     sequential");
    expect(doc).toContain("compaction    llm");
    expect(doc).toContain("steering      step");

    // 缺省串行:第一 turn 没有 execution 决策事件
    await app.submit("go");
    expect(log.events.some((e) => e.type === "decision" && e.slot === "execution")).toBe(false);

    await app.command("/set execution parallel");
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "execution",
      value: "parallel",
    });
    expect(text()).toContain("execution → parallel");
    await app.submit("again");
    const decisions = log.events.filter((e) => e.type === "decision" && e.slot === "execution");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ parallel: 2 });

    await app.command("/set steering turn");
    expect(app.agent.slots.steering).toBeDefined();
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "steering",
      value: "turn",
    });
    await app.command("/inspect slots");
    doc = text();
    expect(doc).toContain("steering      turn");
    expect(doc).toContain("execution     parallel");
    app.stop();
  });

  it("参数校验:非法值给用法;运行中拒绝;/compaction clear 换策略且 /compact 用它;/compaction manual 关自动", async () => {
    const { app, log, text } = boot(scripted([]));
    await app.command("/set execution sideways");
    expect(text()).toContain("Usage: /execution sequential|parallel");
    await app.command("/set preservation ratio 3");
    expect(text()).toContain("ratio must be between 0 and 1");

    // 造几条工具结果,让 clear 策略有东西可清
    for (let i = 0; i < 6; i++) {
      log.append({
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [{ id: `c${i}`, name: "slow", args: {} }],
        stopReason: "tool",
      });
      log.append({
        type: "tool/result",
        at: "",
        callId: `c${i}`,
        name: "slow",
        content: "x".repeat(4000),
        isError: false,
      });
    }
    await app.command("/set compaction clear");
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "compaction",
      value: "clear",
    });
    await app.command("/compact");
    const comp = log.events.at(-1);
    expect(comp?.type).toBe("compaction");
    expect(comp?.type === "compaction" && comp.strategy).toContain("clearToolResults");

    await app.command("/set compaction manual");
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "compactionTrigger",
      value: "manual",
    });
    expect(text()).toContain("compaction → trigger manual");

    await app.command("/set compaction ./does-not-exist.mjs");
    expect(text()).toContain("✗");
    const dir = mkdtempSync(join(tmpdir(), "clarook-slot-values-"));
    let restoredApp: ReturnType<typeof createTuiApp> | undefined;
    try {
      const path = join(dir, "keep · trigger recent.mjs");
      writeFileSync(
        path,
        'export default async ({ events }) => ({ cleared: events.flatMap((event, i) => event.type === "tool/result" ? [i] : []), strategy: "custom-loaded" });',
      );
      await app.command(`/set compaction ${path}`);
      expect(app.setup().values.compaction).toBe(path);
      await app.command("/set compaction manual");
      await app.command("/set preservation ratio 0.00000001");
      expect(app.setup().values.compaction).toBe(path);
      expect(app.setup().values.preservation).toBe("ratio 0.00000001");
      // 在快照之前也能从槽事件恢复,不靠解析显示文字补齐。
      const slots = restoreSessionSetup(log.events, {}).setup;
      expect(slots.values.compaction).toBe(path);
      expect(slots.values.compactionTrigger).toBe("manual");
      expect(slots.values.preservation).toBe("ratio 0.00000001");
      recordSessionSetup(log, app.setup());
      const file = join(dir, "session.jsonl");
      const stored = new EventLog(file);
      for (const event of log.events) stored.append(event);
      await stored.checkpoint();
      stored.recording?.dispose();
      const reloaded = EventLog.load(file);
      const saved = restoreSessionSetup(reloaded.events, {}).setup;
      if (!saved.values.compaction || !saved.values.preservation)
        throw new Error("Restored strategy values are missing");
      const compaction = await buildCompaction(
        { ...saved.values, compactionReserve: 1000 },
        100000,
      );
      compaction.preservation = parsePreservation(saved.values.preservation).policy;
      restoredApp = createTuiApp({
        terminal: new VirtualTerminal(80, 24),
        log: reloaded,
        provider: scripted([]),
        tools: [],
        compaction,
        reserveTokens: 1000,
        info: { model: "m", providerName: "p", sessionFile: "s" },
        startupSettings: saved.values,
        compactionName: saved.values.compaction,
        preservationSpec: saved.values.preservation,
        onExit() {},
      });
      await restoredApp.command("/compact");
      expect(reloaded.events.at(-1)).toMatchObject({
        type: "compaction",
        strategy: "custom-loaded",
      });
      restoredApp.stop();
      // 用户选择另一套组合时,历史渲染不能把旧值重新写进当前状态。
      restoredApp = createTuiApp({
        terminal: new VirtualTerminal(80, 24),
        log: reloaded,
        provider: scripted([]),
        tools: [],
        compaction: {
          ...(await buildCompaction({ compaction: "clear", compactionReserve: 1000 }, 100000)),
          preservation: parsePreservation("tokens 3000").policy,
        },
        reserveTokens: 1000,
        info: { model: "m", providerName: "p", sessionFile: "s" },
        compactionName: "clear",
        preservationSpec: "tokens 3000",
        onExit() {},
      });
      expect(restoredApp.setup().values.compaction).toBe("clear");
      expect(restoredApp.setup().values.preservation).toBe("tokens 3000");
      const broken = join(dir, "broken.mjs");
      writeFileSync(
        broken,
        'let calls = 0; export default async () => { if (++calls === 1) throw null; throw "second compaction rejected"; };',
      );
      await app.command(`/set compaction ${broken}`);
      const beforeFailure = log.events.length;
      await app.command("/compact");
      expect(text()).toContain("✗ null");
      expect(log.events.slice(beforeFailure).some((event) => event.type === "compaction")).toBe(
        false,
      );
      expect(app.agent.running).toBe(false);
      // 上一轮请求的错误不能被误认成本次压缩已经展示过的错误。
      app.agent.setProvider({
        model: "m",
        async complete() {
          throw new Error("old request failed");
        },
      });
      await app.submit("produce a failed request");
      expect(log.events.at(-1)?.type).toBe("request/error");
      await app.command("/compact");
      expect(text()).toContain("second compaction rejected");
      expect(app.agent.running).toBe(false);
      await app.command("/set compaction clear");
      expect(app.setup().values.compaction).toBe("clear");
    } finally {
      restoredApp?.stop();
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
