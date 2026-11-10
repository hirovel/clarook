// 请求折叠:PgUp/PgDn 阅读,Shift+PgUp/PgDn 选择;Enter 展开/折起,Esc 放开;foldSteps 0 从不折。
import { describe, expect, it, vi } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { DEFAULT_STATUS_WIDGETS } from "../src/status-bar.js";
import { testImage } from "./helpers/image.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

function counting(): Provider {
  let n = 0;
  return {
    model: "m",
    async complete(): Promise<AssistantTurn> {
      n += 1;
      return {
        text: `reply number ${n}`,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 100 * n, outputTokens: 10 },
      };
    },
  };
}

function boot(extra: Record<string, unknown> = {}, columns = 110, rows = 30) {
  const term = new VirtualTerminal(columns, rows);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider: counting(),
    tools: [],
    compaction: { strategy: async () => null, window: 10000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "sys",
    onExit: () => {},
    ...extra,
  });
  const doc = () => app.lines(110).map(stripAnsi).join("\n");
  return { app, term, doc };
}

/** 展开的回复正文:从正文列起(边距一格 + 标记列两格);折起的账目行里同样的字前面是 · 。 */
function open(n: number): RegExp {
  return new RegExp(`^ {3}reply number ${n}(?!\\d)`, "m");
}

describe("账簿折叠", () => {
  it("长路径工具摘要在终端中显示路径,不会截断链接控制序列", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "sys" });
    for (let i = 0; i < 4; i++) {
      log.append({
        type: "request",
        at: "",
        model: "m",
        messages: 1,
        tools: ["read"],
        estimatedTokens: 10,
        reason: "turn",
      });
      log.append({
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [
          { id: `c${i}`, name: "read", args: { path: `C:/workspace/${"a".repeat(100)}.txt` } },
        ],
        stopReason: "tool",
      });
      log.append({
        type: "tool/result",
        at: "",
        callId: `c${i}`,
        name: "read",
        content: "contents",
        isError: false,
      });
    }
    const { app, term, doc } = boot({ log });
    try {
      expect(
        doc()
          .split("\n")
          .find((line) => line.includes("≡ Request #1")),
      ).toContain("read C:/workspace/");
      app.tui.renderNow(true);
      const screen = (await term.screen()).join("\n");
      expect(screen).not.toContain("]8;");
      expect(screen).not.toContain("file://");
    } finally {
      app.stop();
    }
  });

  it("最新三步展开,更早的折成一行账目;用户消息永远不折", async () => {
    const log = new EventLog();
    const { app, doc } = boot({ log });
    for (let i = 1; i <= 5; i++) await app.submit(`question ${i}`);
    const d = doc();
    expect(d).toContain("≡ Request #1");
    expect(d).toContain("≡ Request #2");
    expect(d).not.toContain("≡ Request #3");
    expect(d).not.toMatch(open(1));
    expect(d).not.toMatch(open(2));
    expect(d).toMatch(open(3));
    expect(d).toMatch(open(5));
    // 账目里有停止原因、用量与回复首行;用户消息还在
    expect(d).toMatch(/≡ Request #1 {2}replied · in 100 · out 10 tok · reply number 1/);
    for (let i = 1; i <= 5; i++) expect(d).toContain(`› question ${i}`);
    app.stop();

    const replay = boot({ log });
    expect(replay.doc()).toMatch(/≡ Request #1 {2}replied · in 100 · out 10 tok · reply number 1/);
    expect(replay.doc()).toMatch(/≡ Request #2 {2}replied · in 200 · out 10 tok · reply number 2/);
    expect(replay.doc()).toMatch(open(5));
    replay.app.stop();

    // 前置观察者与保存回调都可同步追加;实时摘要的输入规模和旁支顺序必须与重放一致。
    const observedLog = new EventLog();
    const off = observedLog.subscribe((event) => {
      if (event.type === "request")
        observedLog.append({
          type: "ext/event",
          at: "t",
          source: "fixture",
          kind: "request-observed",
          payload: {},
        });
    });
    let persistDuringDraw = false;
    const observed = boot({
      log: observedLog,
      onSetupChange: () => {
        if (!persistDuringDraw) return;
        persistDuringDraw = false;
        observedLog.append({
          type: "ext/event",
          at: "t",
          source: "fixture",
          kind: "setup-observed",
          payload: {},
        });
      },
    });
    let observedReplay: ReturnType<typeof boot> | undefined;
    try {
      observedLog.append({ type: "user/message", at: "t", text: "summarize this" });
      persistDuringDraw = true;
      observedLog.append({
        type: "request",
        at: "t",
        model: "m",
        messages: 2,
        tools: [],
        estimatedTokens: 10,
        reason: "compaction",
      });
      const facts = (text: string) =>
        text.match(/summary request · \d+ messages|fixture\/(?:request|setup)-observed/g);
      const liveFacts = facts(observed.doc());
      expect(liveFacts).toEqual([
        "summary request · 2 messages",
        "fixture/request-observed",
        "fixture/setup-observed",
      ]);
      off();
      observedReplay = boot({ log: observedLog });
      expect(facts(observedReplay.doc())).toEqual(liveFacts);
    } finally {
      off();
      observedReplay?.app.stop();
      observed.app.stop();
    }

    // 正在运行的请求折起后,流式正文和完成回复仍写入原容器,展开不能被旧节点快照覆盖。
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const text = "Late reply heading\n\nLATE_REPLY_BODY";
    const liveLog = new EventLog();
    const live = boot({
      log: liveLog,
      provider: {
        model: "m",
        async complete(_messages, _tools, options) {
          enter();
          await release;
          options?.onDelta?.(text);
          return { text, toolCalls: [], stopReason: "end" };
        },
      } satisfies Provider,
    });
    try {
      const run = live.app.submit("Wait before replying");
      await entered;
      live.app.tui.renderNow(true);
      live.term.feed("\x1b[5;2~");
      live.term.feed("\r");
      expect(live.doc()).toContain("Enter expand");
      live.app.setDraft("keep the steering draft");
      expect(live.doc()).toContain("Esc return live");
      expect(live.doc()).not.toContain("Esc interrupt");
      live.term.feed("\x1b");
      expect(live.app.agent.running).toBe(true);
      expect(live.app.draft()).toBe("keep the steering draft");
      expect(liveLog.events.some((e) => e.type === "session/interrupt")).toBe(false);
      live.app.setDraft("");
      live.term.feed("\x1b[5;2~");
      resume();
      await run;
      expect(live.doc()).toContain("replied");
      expect(live.doc()).not.toContain("LATE_REPLY_BODY");
      live.term.feed("\r");
      expect(live.doc()).toContain("LATE_REPLY_BODY");
      expect(live.doc()).toContain("Enter collapse");
      live.term.feed("\r");
      live.term.feed("\r");
      expect(live.doc()).toContain("LATE_REPLY_BODY");
      expect(liveLog.events.filter((e) => e.type === "assistant/message")).toMatchObject([
        { text },
      ]);
    } finally {
      resume();
      live.app.stop();
    }
  });

  it("翻页阅读与请求选择分开,草稿不变;Enter 折起或展开;Esc 放开;手动展开的不再自动折", async () => {
    const log = new EventLog();
    const { app, term, doc } = boot({ log, readClipboard: async () => ({ image: testImage }) });
    await app.command("/help");
    app.setDraft("keep draft");
    app.tui.renderNow(true);
    const bottom = (await term.screen()).join("\n");
    term.feed("\x1b[5~");
    app.tui.renderNow(true);
    const earlier = (await term.screen()).join("\n");
    expect(earlier).not.toBe(bottom);
    expect(earlier).toContain("Commands");
    term.feed("\x1b[6~");
    app.tui.renderNow(true);
    expect((await term.screen()).join("\n")).toBe(bottom);
    expect(app.draft()).toBe("keep draft");
    expect(log.events.some((e) => e.type === "user/message")).toBe(false);
    app.setDraft("");
    for (let i = 1; i <= 4; i++) await app.submit(`q ${i}`);
    term.feed("\x1b[5;2~"); // Shift+PgUp:从最后一步起
    expect(doc()).toContain("request 4/4");
    term.feed("\x1b[5;2~");
    term.feed("\x1b[5;2~");
    term.feed("\x1b[5;2~");
    expect(doc()).toContain("request 1/4");
    expect(doc()).toContain("› Request #1"); // 折起的账目行带光标
    term.feed("\r"); // 展开
    let d = doc();
    expect(d).toMatch(open(1));
    expect(d).toContain("› Request #1");
    term.feed("\r"); // 再折起
    expect(doc()).not.toMatch(open(1));
    term.feed("\r"); // 展开并 pin
    term.feed("\x1b[6;2~"); // Shift+PgDn → request 2
    expect(doc()).toContain("request 2/4");
    // 检视器跟随主屏所选请求;展开与返回不改变阅读位置、草稿或会话事实。
    app.setDraft("keep request draft");
    const beforeInspect = JSON.stringify(log.events);
    app.tui.renderNow(true);
    const readingRequest = (await term.screen()).join("\n");
    term.feed("\x12"); // Ctrl+R
    expect(app.inspector.lines(110).map(stripAnsi).join("\n")).toContain("Request #2");
    term.feed("\r"); // Enter 展开接收正文
    const received = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(received).toContain("reply number 2");
    expect(received).not.toContain("reply number 4");
    term.feed("\x12"); // Ctrl+R 返回原阅读位置
    app.tui.renderNow(true);
    expect((await term.screen()).join("\n")).toBe(readingRequest);
    expect(app.draft()).toBe("keep request draft");
    expect(JSON.stringify(log.events)).toBe(beforeInspect);
    app.setDraft("");
    term.feed("\x1b"); // 放开
    expect(doc()).not.toContain("request 2/4");
    term.feed("\x12"); // 没有主屏选择时仍打开最新请求列表
    expect(app.inspector.lines(110).map(stripAnsi).join("\n")).toContain("4 requests");
    term.feed("\r");
    expect(app.inspector.lines(110).map(stripAnsi).join("\n")).toContain("Request #4");
    term.feed("\x12");
    await app.submit("q 5");
    // #1 手动展开过,不再自动折;#2 被折
    d = doc();
    expect(d).toMatch(open(1));
    expect(d).toContain("≡ Request #2");
    term.feed("\x1b[5;2~");
    term.feed("\x1bv");
    await vi.waitFor(() => expect(doc()).toContain("1 image(s) attached"));
    term.feed("\r"); // 有图片时 Enter 属于草稿,不能被历史折叠抢走。
    await vi.waitFor(() =>
      expect(log.events.filter((e) => e.type === "user/message").at(-1)).toMatchObject({
        text: "",
        images: [testImage],
      }),
    );
    await vi.waitFor(() => expect(doc()).toContain("reply number 6"));
    app.stop();

    // 矮窗口跳转先显示标题,不能停在请求前的空行;展开、折叠及放开仍指向同一请求。
    const narrow = boot({ log }, 60, 12);
    try {
      narrow.app.tui.renderNow(true);
      narrow.term.feed("\x1b[5;2~");
      narrow.app.tui.renderNow(true);
      expect((await narrow.term.screen()).join("\n")).toContain("› Request #6");
      narrow.term.feed("\r");
      narrow.app.tui.renderNow(true);
      expect((await narrow.term.screen()).join("\n")).toContain("› Request #6");
      narrow.term.feed("\r");
      narrow.app.tui.renderNow(true);
      expect((await narrow.term.screen()).join("\n")).toContain("› Request #6");
      narrow.term.feed("\x1b");
      expect(narrow.doc()).not.toContain("› Request #6");
    } finally {
      narrow.app.stop();
    }

    // 已有请求时也能连续翻完单条长回复,翻页不能变成请求选择或改写输入。
    const longLog = new EventLog();
    const lines = Array.from(
      { length: 80 },
      (_, i) => `PAGE_LINE_${String(i + 1).padStart(3, "0")}`,
    );
    const long = boot(
      {
        log: longLog,
        provider: {
          model: "m",
          async complete() {
            return { text: lines.join("\n\n"), toolCalls: [], stopReason: "end" };
          },
        } satisfies Provider,
      },
      60,
      18,
    );
    try {
      await long.app.submit("Show a long reply");
      long.app.setDraft("保留草稿 while reading");
      const before = JSON.stringify(longLog.events);
      const read = async () => {
        long.app.tui.renderNow(true);
        return (await long.term.screen()).join("\n");
      };
      const seen = new Set<string>();
      let current = await read();
      expect(current).toContain("PAGE_LINE_080");
      for (let i = 0; i < 100; i++) {
        for (const line of current.match(/PAGE_LINE_\d{3}/g) ?? []) seen.add(line);
        if (current.includes("PAGE_LINE_001")) break;
        long.term.feed("\x1b[5~");
        current = await read();
      }
      expect(current).toContain("PAGE_LINE_001");
      expect(seen).toEqual(new Set(lines));
      expect(long.doc()).not.toContain("request 1/1");
      for (let i = 0; i < 100 && !current.includes("PAGE_LINE_080"); i++) {
        long.term.feed("\x1b[6~");
        current = await read();
      }
      expect(current).toContain("PAGE_LINE_080");
      long.term.feed("\x1b[5~");
      await read();
      long.term.feed("\x1b");
      expect(await read()).toContain("PAGE_LINE_080");
      expect(long.app.draft()).toBe("保留草稿 while reading");
      expect(JSON.stringify(longLog.events)).toBe(before);
    } finally {
      long.app.stop();
    }
  });

  it("foldSteps 0 从不折;脉搏在两次请求后出现在状态行", async () => {
    const { app, doc } = boot({
      foldSteps: 0,
      statusWidgets: [...DEFAULT_STATUS_WIDGETS, "trend"],
    });
    for (let i = 1; i <= 5; i++) await app.submit(`q ${i}`);
    const d = doc();
    expect(d).not.toContain("≡ Request #");
    expect(d).toMatch(open(1));
    expect(d).toMatch(/[▁▂▃▄▅▆▇█]{5}/);
    app.stop();
  });
});
