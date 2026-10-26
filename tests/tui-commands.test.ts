// 界面:按键、提交与每条命令。/model、检视器入口、/set effort、/model list、--approve ask、
// 附件与排队、命令的用法与错误分支、槽命令、审批理由输入、编辑器驱动的工具描述编辑。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipboardInput } from "../cli/clipboard-input.js";
import type { ModelSettings } from "../cli/model-settings.js";
import { SessionInputs } from "../cli/session-inputs.js";
import { forkSession } from "../cli/sessions.js";
import { appendMemory } from "../cli/tools/memory.js";
import { createTuiApp, type TuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { ApprovalPrompt } from "../cli/tui-slots.js";
import { llmSummarize } from "../src/compaction.js";
import { DEFAULT_CONFIG_PATH } from "../src/config.js";
import { EventLog } from "../src/log.js";
import type { Message } from "../src/messages.js";
import { deriveMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { Recording } from "../src/recording.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake-model",
    async complete(_m, _t, opts) {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      if (t.text && opts?.onDelta) opts.onDelta(t.text); // 模拟流式:整段作为一次增量
      return t;
    },
  };
}

const echo = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function boot(
  provider: Provider,
  settings?: ModelSettings,
): { app: TuiApp; term: VirtualTerminal; log: EventLog } {
  const term = new VirtualTerminal(100, 40);
  const log = new EventLog();
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: "fake-model", providerName: "fake", sessionFile: "sessions/t.jsonl" },
    ...(settings && { settings }),
    systemPrompt: "sys",
    onExit: () => {},
  });
  return { app, term, log };
}

const text = (app: TuiApp) => app.lines(100).map(stripAnsi).join("\n");

const plain = (s: string) => stripAnsi(s);
const doc = (app: TuiApp) => app.lines(120).map(plain).join("\n");
const tick = () => new Promise((r) => setTimeout(r, 5));

function scriptedB(turns: AssistantTurn[], extra: Partial<Provider> = {}): Provider {
  let i = 0;
  return {
    model: "m",
    async complete(_m, _t, opts) {
      const t = turns[i++] ?? { text: "done", toolCalls: [], stopReason: "end" };
      if (t.reasoning && opts?.onReasoning) opts.onReasoning(t.reasoning.slice(0, 2));
      return t;
    },
    ...extra,
  };
}

const echoB = defineTool({
  name: "echo",
  description: "Echo.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function bootB(provider: Provider, over: Partial<TuiAppDeps> = {}, log = new EventLog()) {
  const term =
    over.terminal instanceof VirtualTerminal ? over.terminal : new VirtualTerminal(120, 40);
  const exits: number[] = [];
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echoB],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "s",
    onExit: () => exits.push(1),
    ...over,
  });
  return { app, term, log, exits };
}

describe("命令:帮助、设置、检视器入口、强度、模型、审批", () => {
  it("用户终端入口:真实命令无 API,范围进入实际请求,忙时保留输入,取消与恢复不重跑", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-user-shell-"));
    const file = join(tmp, "shell.jsonl");
    const log = new EventLog(file);
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(String(init?.body));
      if (sent.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      );
    });
    const provider = openaiCompat({
      model: "m",
      baseUrl: "http://fixture",
      apiKey: "fixture-auth",
    });
    const { app, term } = bootB(
      provider,
      { readClipboard: async () => ({ image: testImage }) },
      log,
    );
    try {
      app.setDraft("!");
      await app.submit("!");
      expect(app.draft()).toBe("!");
      expect(log.events.some((e) => e.type === "user/shell")).toBe(false);
      app.setDraft("!!printf 'LOCAL_ONLY'");
      expect(doc(app)).toContain("[Exclude context]");
      term.feed("\x1b[Z");
      expect(app.draft()).toBe("!printf 'LOCAL_ONLY'");
      term.feed("\x1b[Z");
      expect(app.draft()).toBe("!!printf 'LOCAL_ONLY'");
      term.resize(36, 12);
      await vi.waitFor(async () => {
        const screen = (await term.screen()).join("\n");
        expect(screen).toContain("[Exclude context]");
        expect(screen).toContain("Enter run");
        expect(screen).toContain("Esc chat");
      });
      term.resize(120, 40);
      await app.submit(app.draft());
      expect(sent).toHaveLength(0);
      expect(
        deriveMessages(log.events)
          .map((m) => m.content)
          .join("\n"),
      ).not.toContain("LOCAL_ONLY");
      app.setDraft("");
      term.feed("\x1b[200~！！printf 'WIDE_LOCAL'\x1b[201~");
      expect(doc(app)).toContain("[Exclude context]");
      term.feed("\r");
      await vi.waitFor(() => {
        const result = [...log.events].reverse().find((e) => e.type === "user/shell");
        expect(result).toMatchObject({ excludeFromContext: true });
        expect(result?.content).toContain("WIDE_LOCAL");
      });
      expect(deriveMessages(log.events).some((m) => m.content.includes("WIDE_LOCAL"))).toBe(false);
      await app.command("/shell");
      expect(app.draft()).toBe("!");
      expect(doc(app)).toContain("[Include context]");
      app.setDraft("/shell printf 'SLASH_ENTRY'");
      term.feed("\r");
      await vi.waitFor(() => expect(app.draft()).toBe("!printf 'SLASH_ENTRY'"));
      expect(log.events.filter((e) => e.type === "user/shell")).toHaveLength(2);
      term.feed("\r");
      await vi.waitFor(() =>
        expect(log.events.filter((e) => e.type === "user/shell")).toHaveLength(3),
      );
      expect(deriveMessages(log.events).at(-1)?.content).toContain("SLASH_ENTRY");
      expect(sent).toHaveLength(0);
      await app.submit(`!!cd '${tmp.replace(/\\/g, "/")}' && pwd`);
      await app.submit("!!pwd -W 2>/dev/null || pwd");
      const directory = [...log.events].reverse().find((e) => e.type === "user/shell");
      expect(directory?.content).toContain(process.cwd().replace(/\\/g, "/"));
      // 控制协议进入原始结果,仅显示处理;@引用不能被附件展开。
      await app.submit(
        "!printf '\\033[32mINCLUDED @missing\\033[0m\\n'; printf 'ERROR' >&2; exit 3",
      );
      const shell = [...log.events].reverse().find((e) => e.type === "user/shell");
      expect(shell).toMatchObject({
        isError: true,
        status: "Exit code: 3",
        excludeFromContext: false,
      });
      expect(shell?.content).toContain("\x1b[32mINCLUDED @missing\x1b[0m");
      expect(doc(app)).toContain("Shell failed");
      expect(sent).toHaveLength(0);
      const target = log.events.length - 1;
      app.inspector.openComposition();
      expect(app.inspector.lines(100).map(stripAnsi).join("\n")).toContain("INCLUDED @missing");
      app.inspector.close();
      await app.command(`/edit ${target} EDITED_SHELL_CONTEXT`);
      expect(deriveMessages(log.events).at(-1)?.content).toBe("EDITED_SHELL_CONTEXT");
      await app.command(`/edit restore ${target}`);
      const projected = deriveMessages(log.events).at(-1)?.content;
      expect(projected).toContain("The user ran a shell command");
      expect(projected).toContain("\x1b[32mINCLUDED @missing\x1b[0m");
      const running = app.submit("continue");
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      app.setDraft("!printf 'MUST_NOT_RUN'");
      await app.submit(app.draft());
      expect(app.draft()).toContain("MUST_NOT_RUN");
      expect(doc(app)).toContain("not queued");
      release?.();
      await running;
      const input = JSON.parse(sent[0] ?? "{}").messages;
      expect(input.some((m: { content: string }) => m.content === projected)).toBe(true);
      expect(sent[0]).not.toContain("LOCAL_ONLY");
      expect(sent[0]).not.toContain("MUST_NOT_RUN");
      // 显式返回聊天后,保留前缀文字;编辑器提交时清空草稿不能让它再次变成命令。
      app.setDraft("!!这是普通文字");
      term.feed("\x1b");
      expect(app.draft()).toBe("!!这是普通文字");
      expect(doc(app)).toContain("Chat text");
      const commands = log.events.filter((e) => e.type === "user/shell").length;
      term.feed("\r");
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      await app.agent.waitForIdle();
      expect(log.events.filter((e) => e.type === "user/shell")).toHaveLength(commands);
      expect(JSON.parse(sent[1] ?? "{}").messages.at(-1)?.content).toBe("!!这是普通文字");
      app.setDraft("!printf 'STREAM_READY'; sleep 2; printf 'LATE_SHELL_OUTPUT'");
      const command = app.submit(app.draft());
      await vi.waitFor(() =>
        expect(
          doc(app)
            .split("\n")
            .some((line) => line.trim() === "STREAM_READY"),
        ).toBe(true),
      );
      expect(app.agent.localRunning).toBe(true);
      app.setDraft("keep this draft");
      await app.submit(app.draft());
      expect(app.draft()).toBe("keep this draft");
      await expect(app.agent.continuePending()).rejects.toThrow("User shell is running");
      term.feed("\x1b");
      await command;
      expect(app.agent.running).toBe(false);
      expect(app.agent.localRunning).toBe(false);
      expect(log.events.at(-1)).toMatchObject({
        type: "user/shell",
        status: process.platform === "win32" ? "Result unknown" : "Interrupted",
      });
      if (process.platform === "win32") {
        const completed = log.events.at(-1);
        if (completed?.type !== "user/shell") throw new Error("Shell result missing");
        expect(completed.content).toContain("descendant termination not verified");
        const completedCount = log.events.length;
        const outputStart = [...log.events]
          .reverse()
          .find((e) => e.type === "ext/event" && e.source === "shell");
        if (outputStart?.type !== "ext/event") throw new Error("Shell recording missing");
        const ref = outputStart.payload.output as { file: string; label: string };
        const received = log.recording?.read(ref);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(log.events).toHaveLength(completedCount);
        expect(log.recording?.read(ref)).toBe(received);
        expect(received).not.toContain("LATE_SHELL_OUTPUT");
      }
      expect(sent).toHaveLength(2);
      term.feed("\x1bv");
      await vi.waitFor(() => expect(doc(app)).toContain("1 image(s) attached"));
      app.setDraft("!!printf 'WITH_IMAGE'");
      expect(doc(app)).toContain("not sent to shell");
      await app.submit(app.draft());
      expect(app.draft()).toBe("");
      expect(doc(app)).toContain("1 image(s) attached");
      expect(sent).toHaveLength(2);
      await app.command(`/edit drop ${target}`);
      expect(deriveMessages(log.events).some((m) => m.content.includes("INCLUDED @missing"))).toBe(
        false,
      );
      const fork = forkSession(log.events, log.events.length, tmp, log.recording);
      const source = new Recording(file);
      const copied = new Recording(fork.file);
      for (const event of log.events) {
        if (event.type === "ext/event" && event.source === "shell" && event.payload.output) {
          const ref = event.payload.output as { file: string; label: string };
          expect(copied.read(ref)).toBe(source.read(ref));
        }
      }
      const restored = EventLog.load(file);
      expect(deriveMessages(restored.events)).toEqual(deriveMessages(log.events));
      const replay = bootB(provider, {}, restored);
      expect(doc(replay.app)).toContain("Excluded from model context");
      expect(doc(replay.app)).toContain("Included in next context");
      expect(doc(replay.app)).toContain(
        process.platform === "win32" ? "result unknown" : "Interrupted",
      );
      replay.app.stop();
    } finally {
      release?.();
      app.agent.interrupt();
      await app.agent.waitForIdle();
      app.stop();
      log.recording?.dispose();
      fetch.mockRestore();
    }
  });

  it("/compact 在运行状态显示进度,Esc 通过普通任务入口取消", async () => {
    const instructions = "Keep this structure:\n  first  item\n\n\tsecond item";
    let received = "";
    const { app, term, log } = bootB(scriptedB([]), {
      compaction: {
        strategy: async ({ signal, instructions }) => {
          received = instructions ?? "";
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return null;
        },
        trigger: "manual",
        window: 100000,
        reserveTokens: 1000,
      },
    });
    const running = app.command(`/compact ${instructions}`);
    await tick();
    expect(received).toBe(instructions);
    expect(app.agent.running).toBe(true);
    expect(doc(app)).toContain("compacting");
    await app.command("/compact again");
    expect(doc(app)).toContain("cannot compact while running; press Esc first");
    expect(app.agent.running).toBe(true);
    term.feed("\x1b");
    await running;
    expect(app.agent.running).toBe(false);
    expect(log.events.some((e) => e.type === "session/interrupt")).toBe(true);
    expect(log.events.some((e) => e.type === "request" || e.type === "compaction")).toBe(false);
    app.stop();
  });

  it("/model:列表、切换与默认落盘;阈值和默认保留量跟随当前组合", async () => {
    const calls: string[] = [];
    const settings: ModelSettings = {
      listModels: () => ["fake/fake-model", "other/big-model"],
      switchModel: (name) => {
        calls.push(`switch:${name}`);
        const model = name.endsWith("small-model") ? "small-model" : "big-model";
        return {
          provider: {
            model,
            async complete() {
              return { text: "Short summary.", toolCalls: [], stopReason: "end" };
            },
          },
          model,
          providerName: "other",
          contextWindow: model === "small-model" ? 8000 : 200000,
        };
      },
      setKey: (p, k) => calls.push(`key:${p}:${k}`),
      setDefault: (m) => calls.push(`default:${m}`),
    };
    const { app, term, log } = boot(scripted([]), settings);

    await app.command("/model");
    // 无参数:弹列表选择器,当前模型带 ›;Esc 关闭
    expect(app.dialogLines().map(stripAnsi).join("\n")).toContain("› 1. fake/fake-model");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);

    await app.command("/model other/big-model");
    expect(calls).toContain("switch:other/big-model");
    expect(text(app)).toContain("big-model");
    expect(text(app)).toContain("model switched to big-model");
    expect(app.agent.provider.model).toBe("big-model");

    await app.command("/model default");
    expect(calls).toContain("default:other/big-model");
    settings.listModels = () => {
      throw new Error("Fixture model list unavailable");
    };
    await expect(app.command("/model")).resolves.toBeUndefined();
    expect(text(app)).toContain("Fixture model list unavailable");
    app.setDraft("keep despite picker failure");
    expect(() => term.feed("\x0b")).not.toThrow();
    expect(app.draft()).toBe("keep despite picker failure");
    expect(app.dialogLines()).toEqual([]);

    await app.submit("warm up");
    expect(text(app)).toContain("auto-compact ~168k");
    await app.command("/settings compactionReserve 64000");
    expect(text(app)).toContain("auto-compact ~136k");
    await app.submit("continue");
    expect(log.events.filter((e) => e.type === "request").at(-1)).toMatchObject({
      threshold: 136000,
    });
    await app.command("/settings compactionRatio 0.5");
    expect(text(app)).toContain("auto-compact ~100k");
    expect(app.setup().values.compactionRatio).toBe(0.5);
    await app.submit("use the earlier threshold");
    expect(log.events.filter((e) => e.type === "request").at(-1)).toMatchObject({
      threshold: 100000,
    });
    await app.command("/settings compactionRatio 0");
    expect(text(app)).toContain("auto-compact ~136k");

    await app.command("/set preservation tokens 500");
    await app.command("/settings preservation");
    app.dialogInput("\x1b[D");
    app.dialogInput("\r");
    expect(app.dialogLines().map(stripAnsi).join("\n")).toContain("Restore recommended");
    app.dialogInput("\r");
    await tick();
    expect(app.setup().values.preservation).toBe("tokens 20000");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b");
    await app.command("/set preservation auto");
    await app.command("/model other/small-model");
    const older = log.events.length;
    log.append({
      type: "assistant/message",
      at: "",
      text: "Older findings. ".repeat(1000),
      toolCalls: [],
      stopReason: "end",
    });
    const recent = "Recent request. ".repeat(250);
    log.append({ type: "user/message", at: "", text: recent });
    await app.command("/set compaction llm");
    await app.command("/compact");
    expect(log.events.filter((e) => e.type === "compaction").at(-1)).toMatchObject({
      coversUpTo: older + 1,
    });
    expect(deriveMessages(log.events).some((m) => m.content === recent)).toBe(true);
    expect(deriveMessages(log.events).some((m) => m.content.includes("Older findings."))).toBe(
      false,
    );
    app.stop();
  });

  it("Ctrl+R 打开请求检视器,检视器接管按键,Esc 关闭后回到编辑器", async () => {
    const { app, term, log } = boot(
      scripted([
        {
          text: "ok",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 100, outputTokens: 2 },
        },
      ]),
    );
    await app.submit("x");
    expect(app.inspector.isOpen()).toBe(false);
    term.feed("\x12"); // Ctrl+R
    expect(app.inspector.isOpen()).toBe(true);
    let doc = app.inspector.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("Requests");
    expect(doc).toContain("› #1");
    app.inspector.key("\r");
    doc = app.inspector.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("Request #1");
    expect(doc).toContain("[1 summary]");
    app.inspector.key("\x1b");
    app.inspector.key("\x1b");
    expect(app.inspector.isOpen()).toBe(false);
    expect(app.inspector.lines(100)).toEqual([]);
    // 命令入口同样可用;检视与粘贴不改草稿,关闭后输入恢复。
    app.setDraft("f? draft");
    await app.command("/inspect requests");
    expect(app.inspector.isOpen()).toBe(true);
    const draft = app.draft();
    const before = log.events.length;
    term.feed("\x1b[200~f?123\r\n/quit\x1b[201~");
    expect(app.draft()).toBe(draft);
    expect(log.events).toHaveLength(before);
    term.feed("\x12");
    expect(app.inspector.isOpen()).toBe(false);
    term.feed("f");
    expect(app.draft()).toBe("f? draftf");
    // /events 直接进事件视图,/compactions 直接进压缩对照
    await app.command("/inspect events");
    expect(app.inspector.isOpen()).toBe(true);
    expect(app.inspector.lines(100).map(stripAnsi).join("\n")).toContain("Events");
    app.inspector.close();
    await app.command("/inspect compactions");
    expect(app.inspector.lines(100).map(stripAnsi).join("\n")).toContain("Compactions");
    app.inspector.close();
    app.stop();
  });

  it("/effort 设置强度:状态栏显示、request 事件带级别、不支持的级别提示回退、auto 恢复", async () => {
    const seen: (string | undefined)[] = [];
    const provider: Provider = {
      model: "fake-model",
      async complete(_m, _t, opts) {
        seen.push(opts?.effort);
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    const term = new VirtualTerminal(100, 40);
    const log = new EventLog();
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
      reserveTokens: 32000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
      effortLevels: ["low", "high"],
    });
    await app.command("/set effort");
    // 无参数:弹值选单,当前值标 current;Esc 关闭
    expect(app.dialogLines().map(stripAnsi).join("\n")).toContain("auto");
    expect(app.dialogLines().map(stripAnsi).join("\n")).toContain("current");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);
    await app.command("/set effort xhigh");
    let doc = text(app);
    expect(doc).toContain("· effort xhigh from the next request");
    expect(doc).toContain("clamped down when sending");
    expect(doc).toContain("· effort xhigh");
    await app.submit("x");
    expect(seen).toEqual(["xhigh"]);
    const req = log.events.find((e) => e.type === "request");
    expect(req).toMatchObject({ type: "request", effort: "xhigh" });
    await app.command("/set effort auto");
    doc = text(app);
    expect(doc).toContain("· effort omitted again");
    await app.submit("y");
    expect(seen).toEqual(["xhigh", undefined]);
    await app.command("/set effort ultra");
    expect(text(app)).toContain('unknown level "ultra"');
    app.stop();
  });

  it("/model list 对照服务器与配置,可取消并丢弃迟到结果", async () => {
    const provider: Provider = {
      model: "fake-model",
      async complete() {
        throw new Error("x");
      },
      listModels: async () => ["fake-model", "fresh-model"],
    };
    const settings: ModelSettings = {
      listModels: () => ["fake/fake-model", "fake/retired-model", "other/big-model"],
      switchModel: () => {
        throw new Error("n/a");
      },
      setKey: () => {},
      setDefault: () => {},
    };
    const { app, term } = boot(provider, settings);
    await app.command("/model list");
    await tick();
    // 结果是一个列表选择器:配置里的标 ✓/✗,服务器上多出来的不可选
    const dlg = app.dialogLines().map(stripAnsi).join("\n");
    expect(dlg).toContain("server 2 · configured 2");
    expect(dlg).toContain("fake-model");
    expect(dlg).toContain("retired-model");
    expect(dlg).toContain("possibly retired");
    expect(dlg).toContain("fresh-model");
    expect(dlg).toContain("not in config");
    expect(dlg).not.toContain("big-model");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);

    let finish = (_models: string[]) => {};
    let signal: AbortSignal | undefined;
    provider.listModels = (cancel) => {
      signal = cancel;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    app.setDraft("keep this draft");
    // 即使供应商忽略取消,迟到的结果也不能重新打开选单。
    const pending = app.command("/model list");
    await tick();
    term.feed("\x1b");
    expect(signal?.aborted).toBe(true);
    finish(["fake-model"]);
    await pending;
    await tick();
    expect(app.dialogLines()).toEqual([]);
    expect(app.draft()).toBe("keep this draft");

    await app.command("/model list");
    await app.command("/model");
    expect(signal?.aborted).toBe(true);
    finish(["fake-model"]);
    await tick();
    expect(app.dialogLines().map(stripAnsi).join("\n")).toContain("configured models");
    app.dialogInput("\x1b");

    // 元数据查询也属于同一弹窗,关闭后不能被它的结果覆盖。
    let metadata = (_note: string) => {};
    provider.listModels = async () => ["fake-model"];
    settings.capabilityNote = () =>
      new Promise((resolve) => {
        metadata = resolve;
      });
    await app.command("/model list");
    await tick();
    term.feed("\x0b");
    metadata("late metadata");
    await tick();
    expect(app.dialogLines()).toEqual([]);

    // 查询失败必须可见,并可立即重试;新模型的保存失败也不能被取消边界吞掉。
    settings.capabilityNote = async () => {
      throw new Error("Fixture metadata unavailable", {
        cause: Object.assign(new Error("Private diagnostic content"), { code: "ECONNREFUSED" }),
      });
    };
    await app.command("/model list");
    await tick();
    expect(text(app)).toContain("Fixture metadata unavailable [ECONNREFUSED]");
    expect(text(app)).not.toContain("Private diagnostic content");
    expect(app.dialogLines()).toEqual([]);
    delete settings.capabilityNote;
    settings.describeModel = async () => ({
      model: { name: "fresh-model" },
      caps: { contextWindow: 100000, source: "assumed" },
      source: "assumed",
    });
    settings.addModel = () => {
      throw new Error("Fixture config unavailable");
    };
    provider.listModels = async () => ["fresh-model"];
    await app.command("/model list");
    await tick();
    term.feed("\x1b[B");
    term.feed("\x1b[B");
    term.feed("\r");
    await tick();
    term.feed("\r");
    await tick();
    expect(text(app)).toContain("Fixture config unavailable");

    provider.listModels = (cancel) => {
      signal = cancel;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    await app.command("/model list");
    app.stop();
    expect(signal?.aborted).toBe(true);
    finish(["fake-model"]);
    await tick();
    expect(app.dialogLines()).toEqual([]);
  });

  it("--approve ask:每个调用选择后确认,允许与拒绝回喂模型,本会话记住同名工具", async () => {
    const term = new VirtualTerminal(100, 40);
    const log = new EventLog();
    const app = createTuiApp({
      terminal: term,
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "one" } }],
          stopReason: "tool",
        },
        {
          text: "",
          toolCalls: [{ id: "c2", name: "echo", args: { text: "two" } }],
          stopReason: "tool",
        },
        {
          text: "",
          toolCalls: [{ id: "c3", name: "echo", args: { text: "three" } }],
          stopReason: "tool",
        },
        {
          text: "",
          toolCalls: [{ id: "c4", name: "echo", args: { text: "four" } }],
          stopReason: "tool",
        },
        {
          text: "",
          toolCalls: [{ id: "c5", name: "other", args: { text: "five" } }],
          stopReason: "tool",
        },
        { text: "完事", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echo, { ...echo, name: "other" }],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
      reserveTokens: 32000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
      approve: "ask",
    });
    const tick = () => new Promise((r) => setImmediate(r));
    const running = app.submit("跑");
    term.feed("\x03"); // 模型稍后申请工具审批,不能盖住退出确认。
    await tick();
    const prompt = app.approvalLines().map(stripAnsi).join("\n");
    expect(prompt).toContain("? echo");
    expect(prompt).toContain("› 1. Allow once");
    expect(prompt).toContain("2. Allow this tool for this session");
    expect(prompt).toContain("4. Deny");
    app.tui.renderNow(true);
    expect((await term.screen()).join("\n")).toContain("Quit Clarook");
    term.feed("y");
    expect(app.approvalLines().length).toBeGreaterThan(0);
    expect(app.agent.running).toBe(true);
    term.feed("\x1b");
    expect(app.dialogLines()).toEqual([]);
    term.feed("1");
    term.feed("\r");
    await tick();
    await tick();
    term.feed("4");
    term.feed("\r");
    await tick();
    await tick();
    term.feed("2");
    term.feed("\r");
    await vi.waitFor(() =>
      expect(app.approvalLines().map(stripAnsi).join("\n")).toContain("? other"),
    );
    term.feed("\x1b"); // 本会话许可不跨工具;Esc 拒绝当前调用,模型仍可继续。
    await running;
    const doc = text(app);
    expect(app.approvalLines()).toEqual([]);
    expect(doc).toContain("· approve: allowed echo");
    expect(doc).toContain("· approve: denied echo");
    expect(doc).toContain("· approve: allowed echo (not asked again this session)");
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results.map((r) => r.type === "tool/result" && r.content)).toEqual([
      "echo:one",
      "The user denied this call.",
      "echo:three",
      "echo:four", // 允许本会话后同名工具直接放行
      "The user denied this call.",
    ]);
    expect(doc).toContain("完事");
    app.stop();
  });
});

describe("按键", () => {
  it("面板列快捷键,普通字符归草稿;检视器入口;Ctrl+T 切思考;Ctrl+C 确认退出并保留草稿", async () => {
    let clipboard: ClipboardInput = { image: testImage };
    const { app, term, exits, log } = bootB(scriptedB([]), {
      terminal: new VirtualTerminal(60, 24),
      readClipboard: async () => clipboard,
    });
    const before = log.events.length;
    // 粘贴的是正文,终端颜色和粘贴结束标记不能变成编辑指令或吞掉后半段。
    term.feed("\x1b[200~alpha\x1b[31m中文\x1b[0m\r\nbeta\x1b[201~");
    expect(app.draft()).toBe("alpha中文\nbeta");
    expect(log.events).toHaveLength(before);
    app.setDraft("");
    clipboard = { text: "alpha\x1b[201~\r\nbeta" };
    term.feed("\x1bv");
    await vi.waitFor(() => expect(app.draft()).toBe("alpha\nbeta"));
    expect(log.events).toHaveLength(before);
    app.setDraft("");
    clipboard = { image: testImage };
    term.feed("?");
    expect(app.draft()).toBe("?");
    term.feed("\x0b");
    term.feed("Keyboard shortcuts");
    term.feed("\r");
    expect(plain(app.dialogLines().join("\n"))).toContain("Shortcuts");
    app.tui.renderNow(true);
    expect((await term.screen()).join("\n")).toContain("Esc close");
    term.feed("\x1b[6~");
    expect(plain(app.dialogLines().join("\n"))).toContain("/help");
    // 帮助持有焦点,全局检视快捷键不能盖住它;查看帮助不改变会话记录。
    term.feed("\x12");
    term.feed("\x05");
    expect(app.inspector.isOpen()).toBe(false);
    expect(log.events).toHaveLength(before);
    term.feed("\x1b");
    term.feed("\x15");
    term.feed("draft");
    term.feed("?");
    expect(app.dialogLines()).toEqual([]);
    expect(doc(app)).toContain("draft?");
    term.feed("\x1bv");
    await vi.waitFor(() => expect(doc(app)).toContain("1 image(s) attached"));
    expect(app.draft()).toBe("draft?");
    expect(log.events).toHaveLength(before);
    term.feed("\x1bi");
    expect(plain(app.dialogLines().join("\n"))).toContain("pixel.png");
    term.feed("\x1b[3~");
    expect(plain(app.dialogLines().join("\n"))).toContain("No images attached");
    term.feed("\x1b");
    expect(app.draft()).toBe("draft?");
    const imageDir = mkdtempSync(join(tmpdir(), "clarook-paste-"));
    try {
      const imageFile = join(imageDir, "pasted image.png");
      writeFileSync(imageFile, Buffer.from(testImage.data, "base64"));
      term.feed(`\x1b[200~"${imageFile}"\x1b[201~`);
      await vi.waitFor(() => expect(doc(app)).toContain("1 image(s) attached"));
      expect(app.draft()).toBe("draft?");
      expect(log.events).toHaveLength(before);
      term.feed("\x1bi");
      expect(plain(app.dialogLines().join("\n"))).toContain("pasted image.png");
      term.feed("\x1b[3~");
      term.feed("\x1b");
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
    term.feed("\x15");
    term.feed("\x12");
    expect(app.inspector.isOpen()).toBe(true);
    term.feed("\x12");
    expect(app.inspector.isOpen()).toBe(false);
    term.feed("\x05");
    expect(app.inspector.isOpen()).toBe(true);
    // 检视器打开时,其余按键归它;? 不再打快捷键
    term.feed("?");
    app.inspector.close();
    term.feed("\x14");
    expect(doc(app)).toContain("thinking expanded");
    term.feed("\x14");
    expect(doc(app)).toContain("thinking collapsed");
    for (const open of [
      app.inspector.openEvents,
      app.inspector.openCompactions,
      app.inspector.openComposition,
    ]) {
      open();
      expect(app.inspector.isOpen()).toBe(true);
      expect(app.inspector.lines(120).length).toBeGreaterThan(0);
      app.inspector.close();
    }
    expect(app.inspector.lines(120)).toEqual([]);
    app.setDraft("keep this draft");
    term.feed("\x03");
    try {
      expect(exits).toEqual([]);
      expect(plain(app.dialogLines().join("\n"))).toContain("Quit Clarook");
      term.feed("\x03");
      term.feed("\x16");
      expect(exits).toEqual([]);
      expect(app.draft()).toBe("keep this draft");
      term.feed("\r"); // 默认继续,不退出。
      expect(app.dialogLines()).toEqual([]);
      expect(exits).toEqual([]);
      term.feed("\x03");
      term.feed("\x1b[B");
      term.feed("\x1b"); // 即使选中了退出,Esc 仍回到原界面。
      expect(exits).toEqual([]);
      expect(app.draft()).toBe("keep this draft");
      term.feed("\x03");
      term.feed("\x1b[B");
      term.feed("\r");
      expect(exits).toEqual([1]);
    } finally {
      app.stop();
    }
    let finishPaste = (_value: ClipboardInput) => {};
    const pendingPaste = bootB(scriptedB([]), {
      readClipboard: () =>
        new Promise((resolve) => {
          finishPaste = resolve;
        }),
    });
    try {
      pendingPaste.app.setDraft("/help");
      pendingPaste.term.feed("\x16");
      pendingPaste.term.feed("\x1b\r");
      expect(pendingPaste.log.events.some((e) => e.type === "user/message")).toBe(false);
      expect(pendingPaste.app.draft()).toBe("/help");
      finishPaste({ text: " complete" });
      await vi.waitFor(() => expect(pendingPaste.app.draft()).toBe("/help complete"));
    } finally {
      pendingPaste.app.stop();
    }
  });
});

describe("提交", () => {
  it("长粘贴的占位符只用于显示，保存恢复和 Alt+Enter 提交均使用完整正文", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-paste-draft-"));
    const file = join(tmp, "s.jsonl");
    const content = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行：保留完整粘贴正文。`).join(
      "\n",
    );
    const first = bootB(scriptedB([]), { inputs: new SessionInputs(file, true) });
    try {
      first.term.feed(`\x1b[200~${content}\x1b[201~`);
      first.app.flushInputs();
      expect(new SessionInputs(file, true).read([]).draft.text).toBe(content);
      expect(first.app.draft()).toBe(content);
    } finally {
      first.app.stop();
    }
    const restored = bootB(scriptedB([]), { inputs: new SessionInputs(file, true) });
    try {
      expect(restored.app.draft()).toBe(content);
      restored.app.setDraft("");
      restored.term.feed(`\x1b[200~${content}\x1b[201~`);
      restored.term.feed("\x1b\r");
      await vi.waitFor(() =>
        expect(restored.log.events.find((e) => e.type === "user/message")).toMatchObject({
          text: content,
        }),
      );
      await vi.waitFor(() => expect(restored.app.agent.running).toBe(false));
      expect(restored.app.draft()).toBe("");
    } finally {
      restored.app.stop();
    }
  });
  it("@路径附件:完整附入带空格路径;二进制与非法 UTF-8 提示跳过", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-tui-"));
    writeFileSync(join(tmp, "a.txt"), "hello");
    writeFileSync(join(tmp, "a.bin"), Buffer.from([0, 1, 2, 3]));
    const content = "\uFEFF中文 🙂\r\n  保留缩进\n";
    writeFileSync(join(tmp, "report notes.txt"), content, "utf8");
    writeFileSync(join(tmp, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      let sent: Message[] | undefined;
      const { app, log } = bootB({
        ...scriptedB([]),
        async complete(messages) {
          sent = messages;
          return { text: "ok", toolCalls: [], stopReason: "end" };
        },
      });
      try {
        await app.submit('look at @a.txt and @a.bin @"report notes.txt" @invalid.txt');
        const d = doc(app);
        expect(d).toContain("attached @a.txt (5 bytes)");
        expect(d).toContain("@a.bin: binary file, not attached");
        expect(d).toContain("attached @report notes.txt");
        expect(d).toContain("@invalid.txt: not valid UTF-8 text, not attached");
        const user = log.events.find((e) => e.type === "user/message");
        if (user?.type !== "user/message") throw new Error("Missing user message");
        expect(user.text).toContain(`<file name="report notes.txt">\n${content}\n</file>`);
        expect(sent?.find((message) => message.role === "user")?.content).toBe(user.text);
      } finally {
        app.stop();
      }
    } finally {
      process.chdir(cwd);
    }
  });

  it("运行中提交:缺省排成插话,Alt+Enter 排成后续留言;状态栏计数", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const provider: Provider = {
      model: "m",
      async complete() {
        calls += 1;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return { text: `r${calls}`, toolCalls: [], stopReason: "end" };
      },
    };
    const { app, term } = bootB(provider, {
      terminal: new VirtualTerminal(60, 24),
      readClipboard: async () => ({ image: testImage }),
      info: {
        model: "m",
        providerName: "p",
        sessionFile: `sessions/${"long-directory/".repeat(12)}session.jsonl`,
      },
    });
    const first = app.submit("first");
    await tick();
    expect(doc(app)).toContain("Waiting for model");
    await app.submit("second");
    expect(doc(app)).toContain("queued as steering");
    await app.submit("third", { deliverAs: "followUp" });
    expect(doc(app)).toContain("delivered after the current turn");
    app.tui.renderNow(true);
    const screen = await term.screen();
    expect(screen.length).toBeLessThanOrEqual(24);
    expect(screen.join("\n")).toContain("2 queued");
    expect(screen.at(-1)).toContain("Esc interrupt");
    expect(screen.at(-1)).toContain("Enter next step");
    // 文字与图片都为空才不提交;纯图必须走同一个后续留言通道。
    term.feed("\x1b\r");
    term.feed("\x1bv");
    await vi.waitFor(() => expect(doc(app)).toContain("1 image(s) attached"));
    term.feed("\x1b\r");
    expect(app.agent.pending).toContainEqual(
      expect.objectContaining({ text: "", deliverAs: "followUp", images: [testImage] }),
    );
    app.setDraft("keep the main draft");
    await app.command("/session inputs");
    expect(plain(app.dialogLines().join("\n"))).toContain("[queued]");
    term.feed("\r");
    term.feed("\r");
    expect(plain(app.dialogLines().join("\n"))).toContain("Edit message");
    term.feed("\x01");
    term.feed("\x0b");
    const unfinishedEdit = "keep my unfinished edit\n    with indentation";
    term.feed(`\x1b[200~${unfinishedEdit}\x1b[201~`);
    release?.();
    await first;
    for (let i = 0; i < 20 && calls < 3; i++) await tick();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(app.agent.queued).toBe(0);
    term.feed("\r"); // 原消息在编辑期间已投递;保存失败不能清空尚未应用的文字。
    const dialog = plain(app.dialogLines().join("\n"));
    expect(dialog).toContain("already been delivered");
    expect(dialog).toContain("keep my unfinished edit");
    expect(dialog).toContain("with indentation");
    expect(app.draft()).toBe("keep the main draft");
    term.feed("\x1b");
    term.feed("\x1b");
    expect(app.dialogLines()).toEqual([]);
    expect(app.draft()).toBe("keep the main draft");
    app.stop();
  });
});

describe("命令的分支", () => {
  it("/raw 用法与越界;/sessions 空目录与有会话;/mcp 无与有;/fields 无表与有表", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-tui-"));
    const withFields: Provider = {
      ...scriptedB([{ text: "ok", toolCalls: [], stopReason: "end" }]),
      fields: {
        protocol: "openai",
        sends: ["messages"],
        reads: ["choices"],
        ignores: ["logprobs"],
      },
    };
    const { app } = bootB(withFields, {
      sessionsDir: tmp,

      mcp: {
        statuses: () => [
          { name: "s1", phase: "ready", transport: "stdio", toolCount: 2, ms: 5, missingVars: [] },
          {
            name: "s2",
            phase: "failed",
            transport: "http",
            toolCount: 0,
            ms: 9,
            error: "boom",
            missingVars: ["TOKEN"],
          },
        ],
      },
    });
    await app.command("/inspect raw");
    expect(doc(app)).toContain("no requests yet");
    await app.command("/inspect raw 3");
    expect(doc(app)).toContain("No request #3 (0 so far)");
    await app.command("/inspect sessions");
    expect(doc(app)).toContain(`No sessions in ${tmp}/`);
    writeFileSync(
      join(tmp, "2026-09-01T00-00-00-000Z.jsonl"),
      `${JSON.stringify({ type: "session/start", at: "2026-09-01T00:00:00.000Z", model: "p/m", system: "" })}\n`,
    );
    await app.command("/inspect sessions");
    expect(doc(app)).toContain("1 most recent in");
    expect(doc(app)).toContain("2026-09-01 00:00");
    await app.command("/inspect mcp");
    const d = doc(app);
    expect(d).toContain("MCP 2 servers");
    expect(d).toContain("✓ s1");
    expect(d).toContain("✗ s2");
    expect(d).toContain("boom");
    await app.command("/inspect fields");
    expect(doc(app)).toContain("known but ignored");
    expect(doc(app)).toContain("logprobs");
    await app.submit("go");
    await app.command("/inspect raw 1");
    expect(app.inspector.isOpen()).toBe(true);
    app.inspector.close();
    app.stop();
  });

  it("没有 settings 时 /model 与 /model default 说明;/model list 供应商不支持;/inspect mcp 无服务器;/inspect fields 无表", async () => {
    const { app } = bootB(scriptedB([]));
    await app.command("/model");
    await app.command("/model default");
    await app.command("/model list");
    await app.command("/inspect mcp");
    await app.command("/inspect fields");
    const d = doc(app);
    expect(d.match(/settings interface not configured/g)?.length).toBe(2);
    expect(d).toContain("this provider cannot list models");
    expect(d).toContain("No MCP servers");
    expect(d).toContain("this provider has no field table");
    app.stop();
  });

  it("/prompt 段构成与 instructions-as user 的提示;/compact 失败;/fork 的三种参数;未知命令与模板", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-tui-"));
    const resumed: string[] = [];
    const log = new EventLog();
    log.append({
      type: "session/start",
      at: "",
      model: "m",
      system: "ROLE ENV",
      sections: [
        { name: "role", chars: 4 },
        { name: "env", source: "cwd", chars: 3 },
      ],
    });
    log.append({ type: "user/message", at: "", text: "<instructions>x</instructions>" });
    const { app } = bootB(
      scriptedB([]),
      {
        sessionsDir: tmp,
        switchSession: (target) => {
          if (target.kind === "resume") resumed.push(target.file);
        },
        compaction: {
          strategy: async () => {
            throw new Error("no summary today");
          },
          window: 100000,
          reserveTokens: 1000,
        },
        templates: [{ name: "greet", description: "say hi", body: "Hi $ARGUMENTS", path: "t.md" }],
        skills: [
          {
            name: "review",
            description: "review text",
            body: "Read the request exactly.",
            path: "review/SKILL.md",
            dir: "review",
            disableModelInvocation: false,
          },
        ],
      },
      log,
    );
    await app.command("/inspect prompt");
    let d = doc(app);
    expect(d).toContain("2 sections");
    expect(d).toContain("role");
    expect(d).toContain("cwd");
    expect(d).toContain("first user message (--instructions-as user)");
    expect(d).toContain("memory: off");
    await app.command("/compact");
    expect(doc(app)).toContain("✗ no summary today");
    await app.command("/session fork 0");
    expect(doc(app)).toContain("Usage: /session fork [N]");
    await app.command("/session fork");
    d = doc(app);
    expect(d).toContain("forked: first 1 events");
    await app.command("/session fork 2");
    expect(doc(app)).toContain("forked: first 2 events");
    await app.command("/nothing");
    expect(doc(app)).toContain("unknown command /nothing");
    await app.command("/greet world");
    d = doc(app);
    expect(d).toContain("template /greet");
    expect(d).toContain("› Hi world");
    const structured =
      "Read this:\n```python\ndef f():\n    return 'a  b'\n```\n\n| A | B |\n|---|---|";
    await app.command(`/review ${structured}`);
    expect([...log.events].reverse().find((e) => e.type === "user/message")).toMatchObject({
      text: expect.stringContaining(`User request:\n${structured}`),
    });
    await app.command(`/greet ${structured}`);
    expect([...log.events].reverse().find((e) => e.type === "user/message")).toMatchObject({
      text: `Hi ${structured}`,
    });
    const target = log.events.findIndex((e) => e.type === "user/message");
    await app.command(`/edit ${target} content ${structured}`);
    expect(deriveMessages(log.events).find((m) => m.role === "user")).toMatchObject({
      content: structured,
    });
    await app.command("/session resume C:/project with  spaces/session.jsonl");
    expect(resumed.at(-1)).toBe("C:/project with  spaces/session.jsonl");
    await app.command("/set approve allow read:folder with  spaces/**");
    const approval = [...log.events]
      .reverse()
      .find((e) => e.type === "session/slot" && e.slot === "approve");
    expect(approval).toMatchObject({
      value: expect.stringContaining("read:folder with  spaces/**"),
    });
    app.stop();
  });

  it("/memory:关着时说明;开着时列出、forget N、越界、clear", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-tui-"));
    const project = join(tmp, "AGENTS.md");
    const user = join(tmp, "home", "AGENTS.md");
    mkdirSync(join(tmp, "home"));
    appendMemory(project, "preference", "likes short answers");
    appendMemory(user, "project-fact", "uses pnpm");
    const off = bootB(scriptedB([]));
    await off.app.command("/memory");
    expect(doc(off.app)).toContain("memory is off");
    off.app.stop();
    const { app } = bootB(scriptedB([]), { memory: { project, user } });
    // 无参数弹选单:show · forget · clear;打字 show 直接列
    await app.command("/memory");
    expect(app.dialogLines().map(plain).join("\n")).toContain("forget");
    app.dialogInput("\x1b");
    await app.command("/memory show");
    let d = doc(app);
    expect(d).toContain("Memory 2 entries");
    expect(d).toContain("likes short answers");
    await app.command("/memory forget 9");
    expect(doc(app)).toContain("no entry 9 (2 total)");
    await app.command("/memory forget 1");
    expect(doc(app)).toContain("removed:");
    expect(doc(app)).toContain("likes short answers");
    await app.command("/memory clear");
    d = doc(app);
    expect(d).toContain("cleared 1 memories");
    await app.command("/memory show");
    expect(doc(app)).toContain("no memories");
    app.stop();
  });
});

describe("槽命令的分支", () => {
  it("/preservation 三种输入;/approve 的 allow/deny/forget/outside 与用法;运行中拒绝", async () => {
    const { app, log } = bootB(
      scriptedB([
        { text: "Incomplete summary", toolCalls: [], stopReason: "length" },
        { text: "Earlier findings summarized.", toolCalls: [], stopReason: "end" },
      ]),
      { compaction: { strategy: llmSummarize(), window: 100000, reserveTokens: 1000 } },
    );
    await app.command("/set preservation tokens 500");
    expect(doc(app)).toContain("preservation → tokens 500");
    expect(log.events.at(-1)).toMatchObject({
      slot: "preservation",
      value: "tokens 500",
    });
    log.append({ type: "user/message", at: "", text: "Keep the original task." });
    log.append({
      type: "assistant/message",
      at: "",
      text: "Older findings. ".repeat(500),
      toolCalls: [],
      stopReason: "end",
    });
    log.append({ type: "user/message", at: "", text: "Continue investigating." });
    log.append({
      type: "assistant/message",
      at: "",
      text: "More old findings. ".repeat(500),
      toolCalls: [],
      stopReason: "end",
    });
    log.append({ type: "user/message", at: "", text: "Keep this recent request verbatim." });
    const before = deriveMessages(log.events);
    await app.command("/compact");
    expect(doc(app)).toContain("Summary did not finish (length)");
    expect(deriveMessages(log.events)).toEqual(before);
    expect(log.events.some((e) => e.type === "compaction")).toBe(false);
    expect(log.events.filter((e) => e.type === "request")).toHaveLength(1);
    await app.command("/compact");
    const messages = deriveMessages(log.events);
    expect(messages.some((m) => m.content.includes("Earlier findings summarized."))).toBe(true);
    expect(messages.some((m) => m.content === "Keep this recent request verbatim.")).toBe(true);
    expect(messages.some((m) => m.content.includes("More old findings."))).toBe(false);
    expect(
      log.events.some(
        (e) => e.type === "assistant/message" && e.text.includes("More old findings."),
      ),
    ).toBe(true);
    await app.command("/set preservation ratio 0.3");
    expect(log.events.at(-1)).toMatchObject({ value: "ratio 0.3" });
    await app.command("/set preservation ratio 3");
    expect(doc(app)).toContain("ratio must be between 0 and 1");
    await app.command("/set preservation lots");
    expect(doc(app)).toContain("Usage: /preservation tokens 20000 | ratio 0.3");
    await app.command("/set approve");
    // 无值:审批选单,模式、规则、cwd 之外
    const menu = app.dialogLines().map(plain).join("\n");
    expect(menu).toContain("policy");
    expect(menu).toContain("allow a rule");
    app.dialogInput("\x1b");
    await app.command("/set approve allow");
    expect(doc(app)).toContain("Usage: /approve allow <rule>");
    await app.command("/set approve allow bash:git *");
    expect(doc(app)).toContain("approve → allow bash:git *");
    await app.command("/set approve deny bash:rm *");
    await app.command("/set approve outside allow");
    expect(doc(app)).toContain("approve → outside cwd allow");
    await app.command("/set approve outside sideways");
    expect(doc(app)).toContain("Usage: /approve outside ask|allow|deny");
    await app.command("/set approve forget");
    expect(doc(app)).toContain("Usage: /approve forget <rule>");
    await app.command("/set approve forget bash:git *");
    expect(doc(app)).toContain("approve → forget bash:git *");
    await app.command("/set approve bogus");
    await app.command("/inspect slots");
    const d = doc(app);
    expect(d).toContain("policy:");
    expect(d).toContain("bash:rm *");
    expect(d).not.toContain("allow bash:git *,");
    app.stop();
  });

  it("/toolprompts 内部编辑应用、取消与清空;reset;save 写回配置", async () => {
    const read = defineTool({
      name: "read",
      description: "guided read",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        return "";
      },
    });
    const { app, log } = bootB(scriptedB([]), { tools: [read], toolPrompts: { style: "brief" } });
    await app.command("/set toolprompts edit read");
    const before = log.events.length;
    app.dialogInput(" EDITED");
    expect(read.description).toBe("guided read");
    expect(log.events).toHaveLength(before);
    app.dialogInput("\t");
    app.dialogInput("\r");
    expect(read.description.endsWith("EDITED")).toBe(true);
    expect(doc(app)).toContain("toolPrompts → edit read");
    expect(log.events.at(-1)).toMatchObject({ slot: "toolPrompts", value: "brief, edited: read" });
    await app.command("/set toolprompts");
    expect(app.dialogLines().map(plain).join("\n")).toContain("edit");
    app.dialogInput("\x1b");
    await app.command("/inspect slots");
    expect(doc(app)).toContain("edited: read");
    await app.command("/set toolprompts save");
    const saved = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as {
      toolPrompts?: { style: string; descriptions?: Record<string, string> };
    };
    expect(saved.toolPrompts?.style).toBe("brief");
    expect(saved.toolPrompts?.descriptions?.read?.endsWith("EDITED")).toBe(true);
    await app.command("/set toolprompts reset read");
    expect(read.description).not.toContain("EDITED");
    expect(doc(app)).toContain("toolPrompts → reset read");
    await app.command("/set toolprompts edit read");
    const afterReset = log.events.length;
    app.dialogInput("discard");
    app.dialogInput("\t");
    app.dialogInput("\t");
    app.dialogInput("\r");
    expect(log.events).toHaveLength(afterReset);
    await app.command("/set toolprompts edit read");
    app.dialogInput("\x15");
    app.dialogInput("\t");
    app.dialogInput("\r");
    expect(read.description).toBe("");
    await app.command("/set toolprompts edit");
    expect(doc(app)).toContain("no tool named ?");
    app.stop();
  });

  it("审批提示:选第三项进理由,退格与 Esc 返回;第二项放行后不再问;Esc 视为拒绝", async () => {
    const narrow = new ApprovalPrompt(
      { id: "narrow", name: "read", args: { path: "README.md" } },
      "Tool approval is enabled",
      () => {},
      () => {},
      () => 12,
    );
    const narrowLines = narrow.render(36).map(plain);
    expect(narrowLines.length).toBeLessThanOrEqual(12);
    expect(narrowLines.every((line) => line.length <= 36)).toBe(true);
    const options = narrowLines.join(" ").replace(/\s+/g, " ");
    expect(options).toContain("Allow once");
    expect(options).toContain("Allow this tool for this session");
    expect(options).toContain("Deny and tell the model why");
    expect(options).toContain("Esc");
    expect(options).toContain("Enter confirm");
    const { app } = bootB(
      scriptedB([
        {
          text: "",
          toolCalls: [
            { id: "c1", name: "echo", args: { text: "one" } },
            { id: "c2", name: "echo", args: { text: "two" } },
          ],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      { approve: "ask" },
    );
    const run = app.submit("go");
    for (let i = 0; i < 20 && app.approvalLines().length === 0; i++) await tick();
    expect(plain(app.approvalLines().join("\n"))).toContain("asked for every call");
    app.approvalInput("3");
    app.approvalInput("\r");
    app.approvalInput("a");
    app.approvalInput("b");
    app.approvalInput("\x7f");
    expect(plain(app.approvalLines().join("\n"))).toContain("reason: a");
    app.approvalInput("\x1b[200~\x1b[31m中文🙂\x1b[0m\x1b[201~");
    app.approvalInput("\x7f");
    expect(plain(app.approvalLines().join("\n"))).toContain("reason: a中文");
    app.approvalInput("\x1b");
    expect(plain(app.approvalLines().join("\n"))).toContain("Allow once");
    // 数字只选择,Enter 才执行;普通字母在审批选择阶段不生效。
    app.approvalInput("2");
    expect(plain(app.approvalLines().join("\n"))).toContain(
      "› 2. Allow this tool for this session",
    );
    app.approvalInput("\r");
    await run;
    const d = doc(app);
    expect(d).toContain("allowed echo (not asked again this session)");
    expect(d).toContain("done");
    app.stop();
  });
});
