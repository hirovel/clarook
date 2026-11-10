// 现代终端能力:备用屏布局真的画到了 xterm 的备用缓冲区;焦点事件与通知;/copy 的 OSC 52;
// 路径的 OSC 8 链接;流式合帧;提示标记在整行最前。
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fileUrl, osc8, PROMPT_MARK } from "../cli/terminal-extras.js";
import { createReadTool } from "../cli/tools/fs.js";
import { createTuiApp } from "../cli/tui-app.js";
import { Block } from "../cli/tui-block.js";
import { codeBlocks } from "../cli/tui-commands.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { recordSessionDirectory } from "../src/session-directory.js";
import { testDirectory } from "./helpers/setup.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "m",
    async complete() {
      return turns[Math.min(i++, turns.length - 1)] as AssistantTurn;
    },
  };
}

function boot(term: VirtualTerminal, extra: Record<string, unknown> = {}) {
  const log = new EventLog();
  const app = createTuiApp({
    terminal: term,
    log,
    provider: scripted([
      { text: "hello there\n\n```ts\nconst a = 1;\n```\n\ndone", toolCalls: [], stopReason: "end" },
    ]),
    tools: [],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "sys",
    onExit: () => {},
    ...extra,
  });
  return { app, log };
}

describe("备用屏", () => {
  it("缺省进备用屏:头部在顶、编辑器在底、正文在中间;主屏模式仍是回滚文档", async () => {
    const term = new VirtualTerminal(100, 24);
    const { app, log } = boot(term, {
      info: { model: "deepseek-flash", providerName: "p", sessionFile: "s" },
      statusWidgets: ["context", "cache", "model", "effort", "compaction", "tokens", "position"],
    });
    await app.submit("hi");
    app.tui.renderNow(true);
    const screen = await term.screen();
    const joined = screen.join("\n");
    expect(term.raw.join("")).toContain("\x1b[?1049h"); // 进了备用缓冲区
    expect(screen[0]).toContain("clarook");
    expect(joined).toContain("hello there");
    // 编辑器的横线在最后几行
    const last = screen.slice(-3).join("\n");
    expect(last).toContain("─");
    // 离线文档与主屏模式同形
    const doc = app.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("› hi");
    expect(doc).toContain("hello there");
    const beforeResize = JSON.stringify(log.events);
    term.resize(36, 12);
    app.tui.renderNow(true);
    term.feed("\x1b[5;2~");
    app.tui.renderNow(true);
    const short = await term.screen();
    expect(short.length).toBeLessThanOrEqual(12);
    expect(short.at(-1)).toContain("Enter collapse");
    expect(short.at(-1)).toContain("Esc return live");
    expect(short.join("\n")).toContain("Not shown:");
    app.setDraft("keep after resize");
    term.resize(110, 30);
    app.tui.renderNow(true);
    const restored = (await term.screen()).join("\n");
    expect(restored).toContain("model deepseek-flash");
    expect(restored).toContain("effort Auto (omitted)");
    expect(restored).not.toContain("Not shown:");
    expect(app.draft()).toBe("keep after resize");
    expect(JSON.stringify(log.events)).toBe(beforeResize);
    term.resize(36, 12);
    app.setDraft("Long draft\n".repeat(8));
    log.append({
      type: "ext/event",
      at: "",
      source: "recording",
      kind: "body/gap",
      payload: { reason: "test fixture" },
    });
    app.tui.renderNow(true);
    const gap = await term.screen();
    expect(gap.length).toBeLessThanOrEqual(12);
    expect(gap.join("\n")).toContain("Ctrl+R details");
    expect(gap.at(-1)).toContain("Enter send");
    expect(gap.at(-1)).toContain("Esc return live");
    expect(app.draft()).toBe("Long draft\n".repeat(8));
    app.stop();

    const main = boot(new VirtualTerminal(100, 24), { screen: "main" });
    expect(main.app.tui.mode).toBe("regular");
    main.app.stop();
  });

  it("请求卡头行带 OSC 133 提示标记,标记在整行最前", () => {
    const b = new Block(`${PROMPT_MARK}Request #1   m · turn\nchanged    x`);
    const lines = b.render(60);
    expect(lines[0]?.startsWith(PROMPT_MARK)).toBe(true);
    expect(lines[1]?.startsWith(PROMPT_MARK)).toBe(false);
    expect(stripAnsi(lines[0] ?? "")).toContain("Request #1");
  });
});

describe("通知、标题、剪贴板、链接", () => {
  it.skipIf(process.platform === "win32")("系统没有可选的链接打开器时,进程仍正常返回", () => {
    const root = testDirectory("tui-no-opener-");
    const entry = pathToFileURL(resolve("cli/terminal-extras.ts")).href;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        "--input-type=module",
        "-e",
        `import { openUrl } from ${JSON.stringify(entry)};
        process.env.PATH = ${JSON.stringify(root)};
        openUrl("https://example.invalid");
        setImmediate(() => process.stdout.write("still running"));`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CLAROOK_CREDENTIALS: join(root, "no-credentials.json") },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("still running");
  });

  it("失焦时回合结束发桌面通知加铃;有焦点不发;标题跟状态", async () => {
    const term = new VirtualTerminal(100, 24);
    const titles = term.titles;
    const { app } = boot(term);
    expect(term.raw.join("")).toContain("\x1b[?1004h");
    await app.submit("one");
    expect(term.raw.join("")).not.toContain("\x1b]777;notify");
    term.feed("\x1b[O"); // 失焦
    await app.submit("two");
    const out = term.raw.join("");
    expect(out).toContain("\x1b]777;notify;clarook;turn finished\x07");
    expect(out).toContain("\x1b]9;clarook: turn finished\x07");
    expect(titles.some((t) => t.startsWith("clarook · running"))).toBe(true);
    expect(titles.at(-1)).toBe("clarook · m");
    term.feed("\x1b[I");
    app.stop();
    expect(term.raw.join("")).toContain("\x1b[?1004l");
  });

  it("notify off 不发;always 有焦点也发", async () => {
    const off = new VirtualTerminal(100, 24);
    const a = boot(off, { notify: "off" });
    off.feed("\x1b[O");
    await a.app.submit("x");
    expect(off.raw.join("")).not.toContain("777;notify");
    a.app.stop();
    const always = new VirtualTerminal(100, 24);
    const b = boot(always, { notify: "always" });
    await b.app.submit("x");
    expect(always.raw.join("")).toContain("777;notify");
    b.app.stop();
  });

  it("/copy 写 OSC 52;/copy N 取第 N 个代码块;越界与没回复时报错", async () => {
    const term = new VirtualTerminal(100, 24);
    const { app, log } = boot(term);
    await app.command("/copy");
    expect(app.lines(100).map(stripAnsi).join("\n")).toContain("nothing to copy yet");
    await app.submit("go");
    await app.command("/copy");
    // 回复里有代码块:先选整条回复还是某个代码块
    expect(stripAnsi(app.dialogLines().join("\n"))).toContain("block 1");
    app.dialogInput("\r");
    await new Promise((r) => setTimeout(r, 5));
    const b64 = Buffer.from("hello there\n\n```ts\nconst a = 1;\n```\n\ndone").toString("base64");
    expect(term.raw.join("")).toContain(`\x1b]52;c;${b64}\x07`);
    await app.command("/copy 1");
    expect(term.raw.join("")).toContain(
      `\x1b]52;c;${Buffer.from("const a = 1;").toString("base64")}\x07`,
    );
    await app.command("/copy 2");
    expect(app.lines(100).map(stripAnsi).join("\n")).toContain("has 1 code block; /copy N");
    expect(codeBlocks("a\n```\nx\ny\n```\nb\n```js\nz\n```")).toEqual(["x\ny", "z"]);
    expect(
      codeBlocks("~~~ts\r\n\tconst value = '中文';\r\n~~~\n\n````markdown\n```ts\nx\n```\n````"),
    ).toEqual(["\tconst value = '中文';", "```ts\nx\n```"]);
    expect(codeBlocks("> ```js\n>   x\n> ```\n\n- example\n\n  ~~~\n  y\n  ~~~")).toEqual([
      "  x",
      "y",
    ]);
    expect(codeBlocks("    indented\n\n```\na\n\n```\n\n~~~ts\nunfinished")).toEqual([
      "indented",
      "a\n",
      "unfinished",
    ]);
    const reply = "~~~ts\r\n\tconst value = '中文';\r\n~~~\n\n````markdown\n```ts\nx\n```\n````";
    log.append({
      type: "assistant/message",
      at: "",
      text: reply,
      toolCalls: [],
      stopReason: "end",
    });
    const saved = JSON.stringify(log.events);
    app.setDraft("Keep my draft");
    term.resize(60, 24);
    await app.command("/copy");
    expect(stripAnsi(app.dialogLines().join("\n"))).toContain("block 2");
    app.dialogInput("2");
    app.dialogInput("\r");
    await tick();
    expect(term.raw.join("")).toContain(
      `\x1b]52;c;${Buffer.from("\tconst value = '中文';").toString("base64")}\x07`,
    );
    await app.command("/copy 2");
    expect(term.raw.join("")).toContain(
      `\x1b]52;c;${Buffer.from("```ts\nx\n```").toString("base64")}\x07`,
    );
    await app.command("/copy");
    app.dialogInput("\r");
    await tick();
    expect(term.raw.join("")).toContain(`\x1b]52;c;${Buffer.from(reply).toString("base64")}\x07`);
    expect(app.draft()).toBe("Keep my draft");
    expect(JSON.stringify(log.events)).toBe(saved);
    app.stop();
  });

  it("路径参数的 OSC 8 链接使用调用当时目录,旧日志不虚构相对链接", async () => {
    const a = testDirectory("tui-links-a-");
    const d = testDirectory("tui-links-d-");
    const call = (target: EventLog, id: string, path: string) =>
      target.append({
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [{ id, name: "read", args: { path, offset: 3, limit: 2 } }],
        stopReason: "tool",
      });
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "sys" });
    call(log, "legacy", "unknown.txt");
    const absolute = join(a, "absolute.txt");
    call(log, "absolute", absolute);
    recordSessionDirectory(log, a);
    call(log, "before", "before.txt");
    recordSessionDirectory(log, d);
    call(log, "after", "after.txt");
    const { app } = boot(new VirtualTerminal(100, 24), { cwd: d, log });
    try {
      const child = new EventLog();
      child.append({ type: "session/start", at: "", model: "m", system: "sys" });
      recordSessionDirectory(child, a);
      app.attachChild({
        log: child,
        id: "sub-1",
        task: "Read selected files",
        scope: "taskOnly",
        type: "default",
        resumed: true,
        index: 1,
        state: { status: "running" },
      });
      call(child, "child-before", "child-before.txt");
      recordSessionDirectory(child, d);
      call(child, "child-after", "child-after.txt");
      const screen = app.lines(100).join("\n");
      expect(screen).toContain(osc8("before.txt", fileUrl("before.txt", a)));
      expect(screen).toContain(osc8("after.txt", fileUrl("after.txt", d)));
      expect(screen).toContain(osc8("child-before.txt", fileUrl("child-before.txt", a)));
      expect(screen).toContain(osc8("child-after.txt", fileUrl("child-after.txt", d)));
      expect(screen).toContain(osc8(absolute, fileUrl(absolute)));
      const unknown = screen.split("\n").find((line) => stripAnsi(line).includes("unknown.txt"));
      expect(unknown).toBeDefined();
      expect(unknown).not.toContain("\x1b]8;;");
      expect(stripAnsi(screen)).toContain("before.txt  from line 3, 2 lines");
    } finally {
      app.stop();
    }

    writeFileSync(join(a, "live.txt"), "SESSION_ROOT");
    const live = new EventLog();
    live.append({ type: "session/start", at: "", model: "m", system: "sys" });
    recordSessionDirectory(live, a);
    const current = boot(new VirtualTerminal(100, 24), {
      cwd: a,
      log: live,
      tools: [createReadTool({ cwd: a })],
      approve: "ask",
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "live", name: "read", args: { path: "live.txt" } }],
          stopReason: "tool",
        },
        { text: "Read complete.", toolCalls: [], stopReason: "end" },
      ]),
    });
    const running = current.app.submit("Read the file.");
    try {
      await vi.waitFor(() => expect(current.app.approvalLines().length).toBeGreaterThan(0));
      const link = osc8("live.txt", fileUrl("live.txt", a));
      expect(current.app.lines(100).join("\n")).toContain(link);
      expect(current.app.approvalLines().join("\n")).toContain(link);
      current.app.approvalInput("\r");
      await running;
      expect(live.events.find((event) => event.type === "tool/result")).toMatchObject({
        content: "1\tSESSION_ROOT",
        isError: false,
      });
    } finally {
      current.app.agent.interrupt();
      await running;
      current.app.stop();
    }
  });
});

describe("合帧", () => {
  it("流式增量按帧合并:一帧内的多段只落一次屏,结束时全文到位", async () => {
    const term = new VirtualTerminal(100, 24);
    const log = new EventLog();
    const provider: Provider = {
      model: "m",
      async complete(_m, _t, opts) {
        for (const piece of ["a", "b", "c", "d"])
          opts?.onStream?.({ type: "text/delta", delta: piece });
        return { text: "abcd", toolCalls: [], stopReason: "end" };
      },
    };
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
    });
    await app.submit("go");
    await tick();
    const doc = app.lines(100).map(stripAnsi).join("\n");
    expect(doc).toMatch(/^ {3}abcd\b/m);
    app.stop();
  });
});

describe("文件补全", () => {
  it("真实输入补全两个 @ 文件和带空格路径,选择只更新草稿", async () => {
    const root = testDirectory("tui-completion-");
    writeFileSync(join(root, "alpha.txt"), "FILE_BODY");
    writeFileSync(join(root, "report notes.txt"), "SECOND_BODY");
    const cwd = process.cwd();
    process.chdir(root);
    vi.stubEnv("CLAROOK_CREDENTIALS", join(root, "missing-credentials.json"));
    const term = new VirtualTerminal(100, 24);
    const { app, log } = boot(term);
    try {
      for (const char of "@alpha") term.feed(char);
      await vi.waitFor(async () => {
        app.tui.renderNow(true);
        expect((await term.screen()).join("\n")).toContain("alpha.txt");
      });
      term.feed("\t");
      expect(app.draft()).toBe("@alpha.txt ");
      for (const char of '@"report n') term.feed(char);
      await vi.waitFor(async () => {
        app.tui.renderNow(true);
        expect((await term.screen()).join("\n")).toContain("report notes.txt");
      });
      term.feed("\t");
      expect(app.draft()).toBe('@alpha.txt @"report notes.txt" ');
      expect(log.events.some((event) => event.type === "user/message")).toBe(false);
      expect(app.lines(100).map(stripAnsi).join("\n")).not.toContain("FILE_BODY");
    } finally {
      app.stop();
      process.chdir(cwd);
      vi.unstubAllEnvs();
    }
  });
});
