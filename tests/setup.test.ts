import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPreset, parseCommonArgs, settingsFromArgs } from "../cli/args.js";
import type { Bootstrap } from "../cli/bootstrap.js";
import { bootstrap } from "../cli/bootstrap.js";
import { currentSystem, sectionStates } from "../cli/prompt-sections.js";
import * as registry from "../cli/registry.js";
import { SessionInputs } from "../cli/session-inputs.js";
import { readRequestRecording } from "../cli/session-records.js";
import { forkSession } from "../cli/sessions.js";
import { createTuiApp } from "../cli/tui-app.js";
import { startTuiSession } from "../cli/tui-session.js";
import { DEFAULT_CONFIG_PATH, type KernelConfig } from "../src/config.js";
import { EventLog } from "../src/log.js";
import type { CompleteOptions, Provider } from "../src/provider.js";
import { Recording } from "../src/recording.js";
import { defaultPreset, getSetting, SETTINGS, setSetting } from "../src/settings.js";
import { mergeSetup, SETUP_GUIDE, SETUP_SECTIONS, setupSnapshot } from "../src/setup.js";
import { testImage } from "./helpers/image.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  vi.spyOn(registry, "fetchRegistry").mockResolvedValue(undefined);
  vi.stubEnv("CLAROOK_CREDENTIALS", join(dirname(DEFAULT_CONFIG_PATH), "no-credentials.json"));
  mkdirSync(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
  const config: KernelConfig = {
    default: "p/m",
    providers: { p: { protocol: "openai", baseUrl: "http://localhost", models: ["m"] } },
    defaults: {
      planReminder: 8,
      foldSteps: 9,
      maxSteps: 7,
      systemPromptFile: "instructions.md",
      approval: { allow: [] },
    },
    presets: { small: { planReminder: 4, prompt: { sections: ["role"] } } },
  };
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config));
  return bootstrap();
}

describe("setup data and persistence", () => {
  it("项目 MCP 审核显示命令,跳过不启动,确认后连接工具", async () => {
    const boot = fixture();
    delete boot.config.defaults?.systemPromptFile;
    const helper = resolve("tests/helpers/mcp-server.mjs");
    const dir = mkdtempSync(join(tmpdir(), "clarook-project-review-"));
    boot.config.sessionsDir = join(dir, "sessions");
    const templateSource = join(dirname(DEFAULT_CONFIG_PATH), "prompts");
    writeFileSync(templateSource, "This template source is a file instead of a directory.");
    const command = join(dir, "never-start.mjs");
    const marker = join(dir, "started");
    writeFileSync(
      command,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes");`,
    );
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { local: { command: process.execPath, args: [command] } },
      }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const terminal = new VirtualTerminal(80, 24);
    let host: Awaited<ReturnType<typeof startTuiSession>> | undefined;
    try {
      const starting = startTuiSession({
        boot,
        args: boot.resolve(parseCommonArgs([])),
        terminal: () => terminal,
        onExit() {},
      });
      await vi.waitFor(async () =>
        expect((await terminal.screen()).join("\n")).toContain("Project MCP configuration"),
      );
      expect((await terminal.screen()).join("\n")).toContain("args:");
      terminal.feed("\x1b");
      await vi.waitFor(async () =>
        expect((await terminal.screen()).join("\n")).toContain("Connect project MCP servers?"),
      );
      terminal.feed("\x1b[B");
      terminal.feed("\r");
      host = await starting;
      expect(dirname(resolve(host.file()))).toBe(join(dir, "sessions"));
      expect(existsSync(resolve(host.file()))).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(host.app().lines(80).join("\n")).toContain("project MCP skipped");
      expect(host.app().lines(80).join("\n")).toContain("Skipped template directory");
      expect(host.app().lines(80).join("\n")).toContain("Expected a directory.");
      await host.close();
      host = undefined;

      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [helper] } } }),
      );
      const approvedTerminal = new VirtualTerminal(80, 24);
      const approving = startTuiSession({
        boot,
        args: boot.resolve(parseCommonArgs([])),
        terminal: () => approvedTerminal,
        onExit() {},
      });
      await vi.waitFor(async () =>
        expect((await approvedTerminal.screen()).join("\n")).toContain("Project MCP configuration"),
      );
      approvedTerminal.feed("\x1b");
      await vi.waitFor(async () =>
        expect((await approvedTerminal.screen()).join("\n")).toContain(
          "Connect project MCP servers?",
        ),
      );
      approvedTerminal.feed("\r");
      host = await approving;
      expect(host.app().agent.tools.some((tool) => tool.name === "mcp__local__echo")).toBe(true);
    } finally {
      if (host) await host.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(templateSource, { force: true });
    }
  });

  it("子任务使用派发时的模型和工具,扩展与 MCP 归属子日志,续聊重建资源且不串 cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-child-tools-"));
    vi.stubEnv("CLAROOK_HOME", join(dir, "home"));
    const skillDir = join(dir, "home", "skills", "proof");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: proof\ndescription: Verify facts\n---\nRecord supporting evidence.",
    );
    const badSkill = join(dir, "home", "skills", "broken", "SKILL.md");
    mkdirSync(dirname(badSkill), { recursive: true });
    writeFileSync(badSkill, "---\nname: [broken\n---\nbody");
    const extension = join(dir, "extension.mjs");
    writeFileSync(
      extension,
      `
      export let active = 0;
      export default ({ log }) => {
        active++;
        let calls = 0;
        return {
          tools: [{ name: "read", description: "fixture override", parameters: { type: "object" },
            async execute() {
              log.append({ type: "ext/event", at: "t", source: "fixture", kind: "read", payload: {} });
              return log.path + ":" + (++calls);
            } }],
          dispose() { active--; }
        };
      };
    `,
    );
    const control = (await import(pathToFileURL(extension).href)) as { active: number };
    const config: KernelConfig = {
      default: "p/old",
      providers: {},
      sessionsDir: dir,
      defaults: {
        prompt: { sections: [] },

        subagent: true,
        approve: "all",
        extensions: [extension],
      },
      mcp: {
        servers: {
          fixture: {
            command: process.execPath,
            args: [resolve("tests/helpers/mcp-server.mjs")],
            required: true,
          },
        },
      },
    };
    const seen: { model: string; tools: string[] }[] = [];
    let duringRequest = async () => {};
    const choose = (name = "p/old") => {
      const model = name.replace("p/", "");
      const provider: Provider = {
        model,
        async complete(messages, tools, options) {
          const capture = await options?.record?.(JSON.stringify({ model, messages, tools }));
          capture?.response(200, "text/event-stream");
          await capture?.chunk(new TextEncoder().encode('data: {"fixture":true}\n\n'));
          await capture?.end("complete");
          options?.onRaw?.('data: {"fixture":true}');
          seen.push({ model, tools: tools.map((t) => t.name) });
          const last = messages.at(-1);
          if (last?.role === "user" && last.content === "trace-root")
            return { text: "done", toolCalls: [], stopReason: "end" };
          if (last?.role !== "user") return { text: "done", toolCalls: [], stopReason: "end" };
          if (last.content === "fail") throw new Error("fixture child failure");
          await duringRequest();
          return {
            text: "",
            stopReason: "tool",
            toolCalls: [
              ...(tools.some((t) => t.name === "skill")
                ? [{ id: "skill", name: "skill", args: { name: "proof" } }]
                : []),
              ...(tools.some((t) => t.name === "read")
                ? [{ id: "read", name: "read", args: {} }]
                : []),
              { id: "rpc", name: "mcp__fixture__echo", args: { text: "child" } },
              { id: "pwd", name: "bash", args: { command: "pwd -W 2>/dev/null || pwd" } },
              { id: "cd", name: "bash", args: { command: "cd .." } },
            ],
          };
        },
      };
      return { provider, model, providerName: "p", contextWindow: 100000 };
    };
    const boot: Bootstrap = {
      config,
      configCreated: false,
      choose,
      chooseOrNone: choose,
      resolve: (args) => applyPreset(args, config),
      settings: {
        listModels: () => ["p/old", "p/new"],
        switchModel: choose,
        setKey() {},
        setDefault() {},
      },
    };
    let host: Awaited<ReturnType<typeof startTuiSession>> | undefined;
    const ctx = { signal: new AbortController().signal };
    try {
      const running = await startTuiSession({
        boot,
        args: boot.resolve(parseCommonArgs([])),
        terminal: () => new VirtualTerminal(80, 24),
        onExit() {},
      });
      host = running;
      expect(running.app().lines(110).join("\n")).toContain("Skipped skill");
      expect(
        EventLog.load(running.file()).events.some(
          (e) =>
            e.type === "ext/event" &&
            e.source === "skills" &&
            String(e.payload.message).includes(badSkill),
        ),
      ).toBe(true);
      const task = running.app().agent.tools.find((t) => t.name === "task");
      const bash = running.app().agent.tools.find((t) => t.name === "bash");
      if (!task || !bash) throw new Error("missing runtime tools");
      await bash.execute({ command: "cd .." }, ctx);
      await running.app().command("/model p/new");
      await running.app().command("/tools off write");
      await running.app().command("/settings prompt.skills.mode auto");
      await running.app().command("/settings prompt.skills.load tool");
      await running.app().command("/settings prompt.skills.include proof");
      duringRequest = async () => {
        await running.app().command("/tools off read");
        await running.app().command("/model p/old");
        await running.app().command("/settings prompt.skills.mode manual");
      };
      await task.execute({ task: "first" }, ctx);
      expect(control.active).toBe(1);
      expect(seen.slice(0, 2).map((r) => r.model)).toEqual(["new", "new"]);
      for (const request of seen) {
        expect(request.tools).toContain("read");
        expect(request.tools).toContain("skill");
        expect(request.tools).toContain("mcp__fixture__echo");
        expect(request.tools).not.toContain("write");
      }
      duringRequest = async () => {};
      await task.execute({ task: "resume", resume: "sub-1" }, ctx);
      expect(seen[2]?.model).toBe("old");
      expect(seen[2]?.tools).not.toContain("read");
      expect(seen[2]?.tools).not.toContain("skill");
      const childFile = running.file().replace(/\.jsonl$/, "-sub-1.jsonl");
      const child = EventLog.load(childFile);
      const results = child.events.filter((e) => e.type === "tool/result");
      expect(results.find((e) => e.callId === "skill")?.content).toContain(
        "Record supporting evidence.",
      );
      expect(results.find((e) => e.callId === "read")?.content).toBe(`${childFile}:1`);
      expect(results.filter((e) => e.callId === "rpc").map((e) => e.content)).toEqual([
        "echo: child",
        "echo: child",
      ]);
      expect(
        results
          .filter((e) => e.callId === "pwd")
          .map((e) => e.content.replace(/\\/g, "/").toLowerCase()),
      ).toEqual([
        process.cwd().replace(/\\/g, "/").toLowerCase(),
        process.cwd().replace(/\\/g, "/").toLowerCase(),
      ]);
      expect(child.events.some((e) => e.type === "session/model" && e.model === "old")).toBe(true);
      expect(child.events.some((e) => e.type === "ext/event" && e.source === "fixture")).toBe(true);
      expect(
        child.events.some(
          (e) => e.type === "ext/event" && e.source === "mcp" && e.payload.method === "tools/call",
        ),
      ).toBe(true);
      const parent = EventLog.load(running.file());
      expect(
        parent.events.some(
          (e) =>
            e.type === "ext/event" && (e.source === "fixture" || e.payload.method === "tools/call"),
        ),
      ).toBe(false);
      await expect(task.execute({ task: "fail" }, ctx)).rejects.toThrow("fixture child failure");
      expect(control.active).toBe(1);
      const echo = running.app().agent.tools.find((t) => t.name === "mcp__fixture__echo");
      if (!echo) throw new Error("missing MCP tool");
      expect(await echo.execute({ text: "parent still connected" }, ctx)).toBe(
        "echo: parent still connected",
      );
      // 父、子各写各的旁路文件;重新打开读取也不依赖当前工具或 provider。
      await running.app().submit("trace-root");
      const parentLog = EventLog.load(running.file());
      const rootIndex = parentLog.events.findIndex((e) => e.type === "request");
      const rootTrace = readRequestRecording(running.file(), parentLog.events, rootIndex);
      expect(JSON.parse(rootTrace?.bodies[0] ?? "{}").model).toBe("old");
      const childIndex = child.events.findIndex((e) => e.type === "request");
      const childTrace = readRequestRecording(childFile, child.events, childIndex);
      expect(JSON.parse(childTrace?.bodies[0] ?? "{}").model).toBe("new");
      running.app().inspector.open();
      running.app().inspector.key("\r");
      running.app().inspector.key("5");
      expect(running.app().inspector.lines(110).join("\n")).toContain(
        "Captured before HTTP dispatch",
      );
      running.app().inspector.close();
      const history = createTuiApp({
        terminal: new VirtualTerminal(60, 30),
        log: parentLog,
        provider: running.app().agent.provider,
        tools: [],
        info: { model: "old", providerName: "fixture", sessionFile: running.file() },
        compaction: { strategy: async () => null, window: 64000, reserveTokens: 1000 },
        reserveTokens: 1000,
        systemPrompt: "unused",
        onExit() {},
      });
      try {
        history.inspector.open();
        history.inspector.key("\r");
        history.inspector.key("5");
        expect(history.inspector.lines(60).join("\n")).toContain("Captured before HTTP dispatch");
      } finally {
        history.stop();
      }
      await running.close();
      host = await startTuiSession({
        boot,
        args: boot.resolve(parseCommonArgs([])),
        terminal: () => new VirtualTerminal(80, 24),
        onExit() {},
      });
      await host.app().submit("trace-root");
      expect(existsSync(host.file().replace(/\.jsonl$/, ".records"))).toBe(true);
      await host
        .app()
        .agent.tools.find((t) => t.name === "task")
        ?.execute({ task: "trace-root" }, ctx);
      expect(existsSync(host.file().replace(/\.jsonl$/, "-sub-1.records"))).toBe(true);
      await host.switchSession({ kind: "resume", file: running.file(), source: "current" });
      host.app().inspector.open();
      host.app().inspector.key("\r");
      host.app().inspector.key("5");
      expect(host.app().inspector.lines(110).join("\n")).toContain("Captured before HTTP dispatch");
    } finally {
      await host?.close();
      expect(control.active).toBe(0);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("退出等候可操作:重复 Ctrl+C 不提前退出,强制退出保留未知和输入,清理卡住也能退出", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-exit-"));
    try {
      for (const mode of [
        "approval",
        "wait",
        "force",
        "cleanup",
        "cleanup-error",
        "fatal-save",
        "record-save",
      ] as const) {
        const extension = join(dir, `${mode}.mjs`);
        writeFileSync(
          extension,
          `
          export let started = false;
          export let cleaning = false;
          export let finishTool = () => {};
          export let finishCleanup = () => {};
          export default () => ({
            tools: [{ name: "stuck", description: "A cancellable test boundary.", parameters: { type: "object" },
              execute() { started = true; return new Promise(resolve => { finishTool = () => resolve("done"); }); } }],
            dispose() { cleaning = true; ${mode === "cleanup" ? "return new Promise(resolve => { finishCleanup = resolve; });" : mode === "cleanup-error" ? 'throw new Error("Fixture cleanup rejected");' : ""} }
          });
        `,
        );
        const control = (await import(pathToFileURL(extension).href)) as {
          started: boolean;
          cleaning: boolean;
          finishTool(): void;
          finishCleanup(): void;
        };
        const config: KernelConfig = {
          default: "p/m",
          providers: { p: { protocol: "openai", baseUrl: "http://unused", models: ["m"] } },
          sessionsDir: dir,
          defaults: {
            prompt: { sections: [] },

            approve: mode === "approval" ? "ask" : "all",
            extensions: [extension],
          },
        };
        const choose = () => ({
          model: "m",
          providerName: "p",
          contextWindow: 100000,
          provider: {
            model: "m",
            async complete() {
              return {
                text: "",
                toolCalls: [
                  { id: "unfinished", name: "stuck", args: { task: "finish the release" } },
                ],
                stopReason: "tool" as const,
              };
            },
          },
        });
        const boot: Bootstrap = {
          config,
          configCreated: false,
          choose,
          chooseOrNone: choose,
          resolve: (args) => applyPreset(args, config),
          settings: {
            listModels: () => ["p/m"],
            switchModel: choose,
            setKey() {},
            setDefault() {},
          },
        };
        const term = new VirtualTerminal(60, 24);
        let exits = 0;
        const host = await startTuiSession({
          boot,
          args: boot.resolve(parseCommonArgs([])),
          terminal: () => term,
          onExit: () => {
            exits++;
          },
        });
        const running = host.app().submit("Do the work.");
        try {
          if (mode === "approval") {
            await vi.waitFor(() => expect(host.app().approvalLines().length).toBeGreaterThan(0));
            host.app().setDraft("Keep this draft.");
            void host.app().agent.prompt("Keep this pending message.");
            term.feed("3");
            term.feed("\r");
            term.feed("Keep this reason until I decide.");
            term.feed("\x03");
            term.feed("\r"); // 默认继续,不把退出确认的 Enter 当成审批提交。
            expect(host.app().approvalLines().join("\n")).toContain("Keep this reason");
            expect(control.started).toBe(false);
            expect(exits).toBe(0);
            term.feed("\x03");
            term.feed("\x1b[B");
            term.feed("\r");
            await vi.waitFor(() => expect(exits).toBe(1));
            await running;
            expect(control.started).toBe(false);
            expect(host.app().approvalLines()).toEqual([]);
            const events = EventLog.load(host.file()).events;
            expect(events.filter((e) => e.type === "tool/result")).toMatchObject([
              { content: "Interrupted by the user; not executed.", isError: true },
            ]);
            expect(events.some((e) => e.type === "tool/unresolved")).toBe(false);
            const inputs = new SessionInputs(host.file(), true).read(events);
            expect(inputs?.draft.text).toBe("Keep this draft.");
            expect(inputs?.pending).toMatchObject([
              { text: "Keep this pending message.", paused: true },
            ]);
            continue;
          }
          await vi.waitFor(() => expect(control.started).toBe(true));
          void host.app().agent.prompt("Keep this pending message.");
          host.app().setDraft("Keep this draft.");
          const snapshot = host.file().replace(/\.jsonl$/, ".inputs.json");
          if (mode === "record-save") {
            renameSync(host.file(), `${host.file()}.hold`);
            mkdirSync(host.file());
          }
          if (mode === "fatal-save") {
            rmSync(snapshot, { force: true });
            mkdirSync(snapshot);
            void host.close("uncaught exception: Fixture fatal error");
            await vi.waitFor(() =>
              expect(host.app().dialogLines().join("\n")).toContain(
                "Retry saving and continue shutdown",
              ),
            );
            expect(host.app().agent.pending[0]?.paused).toBe(true);
            await expect(host.app().submit("must remain stopped")).rejects.toThrow("not submitted");
            const file = host.file();
            await host.switchSession({ kind: "new" });
            expect(host.file()).toBe(file);
            rmdirSync(snapshot);
            term.feed("\x1b[B");
            term.feed("\r");
          } else {
            term.feed("\x03");
            expect(host.app().dialogLines().join("\n")).toContain("Quit Clarook");
            expect(host.app().agent.running).toBe(true);
            expect(exits).toBe(0);
            term.feed("\x1b[B");
            term.feed("\r");
          }
          await vi.waitFor(() =>
            expect(host.app().dialogLines().join("\n")).toContain(
              mode === "fatal-save" ? "Fatal error" : "Exiting",
            ),
          );
          term.feed("\x03");
          term.feed("\x0b");
          expect(host.app().dialogLines().join("\n")).toContain("stuck · unfinished");
          await expect(host.app().submit("must not be silently accepted")).rejects.toThrow(
            "not submitted",
          );
          const closing = host.close();
          let settled = false;
          void closing.then(() => {
            settled = true;
          });
          await Promise.resolve();
          expect(settled).toBe(false);
          expect(exits).toBe(0);
          const saved = () =>
            new SessionInputs(host.file(), true).read(
              EventLog.load(existsSync(`${host.file()}.hold`) ? `${host.file()}.hold` : host.file())
                .events,
            );
          expect(saved()?.draft.text).toBe("Keep this draft.");
          expect(saved()?.pending).toMatchObject([
            { text: "Keep this pending message.", paused: true },
          ]);
          if (mode === "force") {
            expect(host.close("uncaught exception: Failure during shutdown")).toBe(closing);
            expect(host.app().dialogLines().join("\n")).toContain("Failure during shutdown");
            rmSync(snapshot);
            mkdirSync(snapshot);
            host.app().setDraft("Preserve the latest draft too.");
            term.feed("\x1b[F");
            term.feed("\r");
            expect(exits).toBe(0);
            expect(host.app().dialogLines().join("\n")).toContain("Cannot exit:");
            rmdirSync(snapshot);
            term.feed("\x1b[F");
            term.feed("\r");
            await closing;
            expect(exits).toBe(1);
            expect(saved()?.draft.text).toBe("Preserve the latest draft too.");
            expect(
              EventLog.load(host.file()).events.find((e) => e.type === "session/exit"),
            ).toMatchObject({ error: expect.stringContaining("Failure during shutdown") });
            expect(
              EventLog.load(host.file()).events.filter((e) => e.type === "tool/unresolved"),
            ).toMatchObject([
              {
                callId: "unfinished",
                content: expect.stringContaining("force exit was requested"),
              },
            ]);
          } else {
            control.finishTool();
            if (mode === "record-save") {
              await vi.waitFor(() =>
                expect(host.app().dialogLines().join("\n")).toContain(
                  "Retry saving and continue shutdown",
                ),
              );
              expect(exits).toBe(0);
              rmdirSync(host.file());
              renameSync(`${host.file()}.hold`, host.file());
              term.feed("\x1b[B");
              term.feed("\r");
            }
            if (mode === "cleanup" || mode === "cleanup-error") {
              await vi.waitFor(() => expect(control.cleaning).toBe(true));
              expect(exits).toBe(0);
              expect(host.app().dialogLines().join("\n")).toContain("releasing resources");
              if (mode === "cleanup-error")
                await vi.waitFor(() =>
                  expect(host.app().dialogLines().join("\n")).toContain("Fixture cleanup rejected"),
                );
              term.feed("\x1b[F");
              term.feed("\r");
            }
            await closing;
            await vi.waitFor(() => expect(exits).toBe(1));
            expect(
              EventLog.load(host.file()).events.some((e) => e.type === "tool/unresolved"),
            ).toBe(false);
          }
          expect(
            EventLog.load(host.file()).events.filter((e) => e.type === "session/exit"),
          ).toHaveLength(
            mode === "wait" || mode === "fatal-save" || mode === "record-save" ? 0 : 1,
          );
        } finally {
          host.app().approvalInput("\x1b");
          control.finishTool();
          control.finishCleanup();
          await running;
          await host.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("实际会话切换:新建取当前组合,分叉取历史前缀,显示偏好保持,初始化失败保留会话与草稿", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-switch-"));
    const config: KernelConfig = {
      default: "p/m",
      providers: { p: { protocol: "openai", baseUrl: "http://unused", models: ["m"] } },
      sessionsDir: dir,
      defaults: { prompt: { sections: [] } },
    };
    let block = false;
    let requests = 0;
    let failTerminalStart = false;
    let failedTerminal: VirtualTerminal | undefined;
    const choose = (name = "p/m") => ({
      model: name.replace(/^p\//, ""),
      providerName: "p",
      contextWindow: 100000,
      provider: {
        model: name.replace(/^p\//, ""),
        async complete(_messages: unknown, _tools: unknown, opts?: CompleteOptions) {
          requests++;
          if (block) {
            await new Promise<void>((resolve) =>
              opts?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            return { text: "", toolCalls: [], stopReason: "aborted" as const };
          }
          return { text: "done", toolCalls: [], stopReason: "end" as const };
        },
      },
    });
    const boot: Bootstrap = {
      config,
      configCreated: false,
      choose,
      chooseOrNone: choose,
      resolve: (args) => applyPreset(args, config),
      settings: {
        listModels: () => ["p/m"],
        switchModel: choose,
        setKey() {},
        setDefault() {},
        saveSetting: (key, value) => {
          config.defaults = setSetting(config.defaults, key, value);
        },
      },
    };
    const host = await startTuiSession({
      boot,
      args: boot.resolve(parseCommonArgs([])),
      terminal: () => {
        const terminal = new VirtualTerminal(60, 24);
        if (failTerminalStart) {
          failTerminalStart = false;
          failedTerminal = terminal;
          vi.spyOn(terminal, "start").mockImplementation(() => {
            throw new Error("Terminal start failed");
          });
          vi.spyOn(terminal, "stop");
        }
        return terminal;
      },
      onExit() {},
    });
    try {
      const original = host.file();
      host.app().setDraft("Draft stays with its session\n第二行");
      const prefix = EventLog.load(original).events.length;
      await host.app().command("/settings execution parallel");
      await host.app().command("/settings fold off");
      boot.settings.saveSetting?.("execution", "sequential");
      await host.switchSession({ kind: "new" });
      expect(host.app().draft()).toBe("");
      expect(host.file()).not.toBe(original);
      expect(host.app().setup().values.execution).toBe("parallel");
      expect(host.app().setup().values.fold).toBe(false);
      const fork = forkSession(
        EventLog.load(original).events,
        prefix,
        dir,
        new Recording(original),
      );
      await host.switchSession({ kind: "resume", file: fork.file });
      expect(host.app().setup().values.execution).toBe("sequential");
      expect(host.app().setup().values.fold).toBe(false);
      await host.switchSession({ kind: "resume", file: original });
      expect(host.app().draft()).toBe("Draft stays with its session\n第二行");
      expect(host.app().setup().values.execution).toBe("parallel");
      // 磁盘暂不可写时切走再切回,必须复用内存日志;恢复后只补写一次。
      renameSync(original, `${original}.hold`);
      mkdirSync(original);
      await host.app().submit("unsaved probe");
      await host.switchSession({ kind: "new" });
      await host.switchSession({ kind: "resume", file: original });
      expect(host.app().lines(110).join("\n")).toContain("unsaved probe");
      rmdirSync(original);
      renameSync(`${original}.hold`, original);
      await vi.waitFor(
        () =>
          expect(
            EventLog.load(original).events.filter(
              (e) => e.type === "user/message" && e.text === "unsaved probe",
            ),
          ).toHaveLength(1),
        { timeout: 2500 },
      );
      block = true;
      const running = host.app().submit("long task");
      await vi.waitFor(() => expect(host.app().agent.running).toBe(true));
      void host.app().agent.prompt("first pending");
      void host.app().agent.prompt("remove pending");
      host.app().setDraft("a recovered draft");
      host.app().agent.interrupt();
      await running;
      block = false;
      await host.switchSession({ kind: "new" });
      const beforeRestore = requests;
      const restoredTerminal = new VirtualTerminal(60, 24);
      const restarted = await startTuiSession({
        boot,
        args: boot.resolve(parseCommonArgs(["--resume", original])),
        terminal: () => restoredTerminal,
        onExit() {},
      });
      try {
        await vi.waitFor(() => expect(restarted.app().draft()).toBe("a recovered draft"));
        expect(requests).toBe(beforeRestore);
        expect(restarted.app().agent.pending.every((p) => p.paused)).toBe(true);
        await restarted.app().command("/session inputs");
        const pending = restarted.app().agent.pending;
        for (const key of ["d", "c", "s"]) restarted.app().dialogInput(key);
        expect(restarted.app().agent.pending).toEqual(pending);
        restarted.app().dialogInput("\r");
        restarted.app().dialogInput("\r");
        restarted.app().dialogInput("\x15");
        restoredTerminal.feed("remove");
        restoredTerminal.feed("\x01");
        restoredTerminal.feed("\x0b"); // 编辑时属于删除到行尾,不能关闭编辑器。
        expect(restarted.app().dialogLines().join("\n")).toContain("Edit message");
        restoredTerminal.feed("\x1b[200~\x1b[31medited pending\n第二行\x1b[0m\x1b[201~");
        restarted.app().dialogInput("\r");
        expect(restarted.app().agent.pending[0]?.text).toBe("edited pending\n第二行");
        restarted.app().dialogInput("\x1b[B");
        restarted.app().dialogInput("\r");
        restarted.app().dialogInput("2");
        restarted.app().dialogInput("\r");
        expect(restarted.app().agent.queued).toBe(1);
        restarted.app().dialogInput("\r");
        restarted.app().dialogInput("3");
        restarted.app().dialogInput("\r");
        await restarted.app().agent.waitForIdle();
        expect(restarted.app().agent.queued).toBe(0);
        expect(
          EventLog.load(original).events.filter(
            (e) => e.type === "user/message" && e.text === "edited pending\n第二行",
          ),
        ).toHaveLength(1);
        expect(restarted.app().draft()).toBe("a recovered draft");
      } finally {
        await restarted.close();
      }
      await host.switchSession({ kind: "resume", file: original });
      expect(host.app().agent.queued).toBe(0);
      await host.app().command("/settings saveInputs off");
      host.app().setDraft("memory only");
      await host.switchSession({ kind: "new" });
      await host.switchSession({ kind: "resume", file: original });
      expect(host.app().draft()).toBe("memory only");
      expect(existsSync(original.replace(/\.jsonl$/, ".inputs.json"))).toBe(false);
      await host.app().command("/settings saveInputs on");
      let view = host.app();
      view.setDraft("keep this draft");
      view.flushInputs();
      const blockedSnapshot = original.replace(/\.jsonl$/, ".inputs.json");
      rmSync(blockedSnapshot);
      mkdirSync(blockedSnapshot);
      view.setDraft("keep this draft after save failure");
      const blockedSwitch = host.switchSession({ kind: "new" });
      await vi.waitFor(() => expect(view.dialogLines().join("\n")).toContain("preparation failed"));
      view.dialogInput("\x1b");
      await blockedSwitch;
      expect(host.app()).toBe(view);
      await expect(host.close()).rejects.toThrow();
      expect(view.draft()).toBe("keep this draft after save failure");
      rmdirSync(blockedSnapshot);
      view.flushInputs();
      view.setDraft("keep this draft");
      config.defaults = { ...config.defaults, extensions: [join(dir, "missing-extension.mjs")] };
      const pending = host.switchSession({ kind: "new", source: "defaults" });
      await vi.waitFor(() => expect(view.dialogLines().join("\n")).toContain("preparation failed"));
      view.dialogInput("\x1b");
      await pending;
      expect(host.app()).toBe(view);
      expect(view.draft()).toBe("keep this draft");
      expect(view.agent.running).toBe(false);
      const rejectedExtension = join(dir, "rejected-extension.mjs");
      writeFileSync(
        rejectedExtension,
        'export default () => { throw "initialization rejected"; };',
      );
      config.defaults = { ...config.defaults, extensions: [rejectedExtension] };
      const rejectedSwitch = host.switchSession({ kind: "new", source: "defaults" });
      try {
        await vi.waitFor(() =>
          expect(view.dialogLines().join("\n")).toContain("initialization rejected"),
        );
      } finally {
        view.dialogInput("\x1b");
        await rejectedSwitch;
      }
      expect(host.app()).toBe(view);
      expect(view.draft()).toBe("keep this draft");
      config.defaults = { ...config.defaults, extensions: [], planReminder: 5 };
      const legacyFile = join(dir, "legacy.jsonl");
      const legacy = new EventLog(legacyFile);
      legacy.append({ type: "session/start", at: "", model: "m", system: "old instructions" });
      legacy.recording?.flush();
      legacy.recording?.dispose();
      const legacyInputs = legacyFile.replace(/\.jsonl$/, ".inputs.json");
      const unchangedHistory = readFileSync(legacyFile, "utf8");
      writeFileSync(legacyInputs, "{ broken input snapshot");
      const corruptRestore = host.switchSession({
        kind: "resume",
        file: legacyFile,
        source: "current",
      });
      await vi.waitFor(() =>
        expect(host.app().dialogLines().join("\n")).toContain("preparation failed"),
      );
      host.app().dialogInput("\x1b");
      await corruptRestore;
      expect(readFileSync(legacyFile, "utf8")).toBe(unchangedHistory);
      expect(host.app()).toBe(view);
      expect(view.draft()).toBe("keep this draft");
      rmSync(legacyInputs);
      failTerminalStart = true;
      const failedStart = host.switchSession({
        kind: "resume",
        file: legacyFile,
        source: "current",
      });
      await vi.waitFor(() =>
        expect(host.app().dialogLines().join("\n")).toContain("Terminal start failed"),
      );
      host.app().dialogInput("\x1b");
      await failedStart;
      expect(readFileSync(legacyFile, "utf8")).toBe(unchangedHistory);
      expect(failedTerminal?.stop).toHaveBeenCalledOnce();
      view = host.app();
      expect(view.draft()).toBe("keep this draft");
      const restoring = host.switchSession({ kind: "resume", file: legacyFile });
      await vi.waitFor(() =>
        expect(view.dialogLines().join("\n")).toContain("Review session setup"),
      );
      expect(view.dialogLines().join("\n")).toContain("[defaults]");
      view.dialogInput("\r");
      view.dialogInput("\x15");
      view.dialogInput("\x1b[200~p/m\x1b[201~");
      view.dialogInput("\r");
      expect(view.dialogLines().join("\n")).toContain("[edited] model");
      view.dialogInput("\r");
      view.dialogInput("\x15");
      view.dialogInput("\x1b[200~cancel-this-change\x1b[201~");
      view.dialogInput("\x1b");
      view.dialogInput("\x1b[F");
      view.dialogInput("\r");
      await restoring;
      expect(host.file()).toBe(legacyFile);
      expect(host.app().setup().values.planReminder).toBe(5);
      expect(host.app().setup().values.model).toBe("p/m");
      expect(currentSystem(EventLog.load(legacyFile).events)).toBe("old instructions");
      config.defaults = { ...config.defaults, prompt: { sections: ["env"] } };
      await host.switchSession({ kind: "resume", file: legacyFile, source: "defaults" });
      const changed = EventLog.load(legacyFile).events;
      expect(currentSystem(changed)).not.toBe("old instructions");
      expect(sectionStates(changed)?.map((s) => s.name)).toEqual(["Environment"]);
      expect(changed[0]).toMatchObject({ system: "old instructions" });
      const reviewFile = join(dir, "review-only.jsonl");
      const reviewLog = new EventLog(reviewFile);
      reviewLog.append({
        type: "session/start",
        at: "",
        model: "m",
        system: "keep",
      });
      reviewLog.append({
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [
          {
            id: "uncertain-write",
            name: "write",
            args: { path: "never-write.txt", content: "must not run" },
          },
        ],
        stopReason: "tool",
      });
      reviewLog.recording?.flush();
      reviewLog.recording?.dispose();
      const requestsBeforeUnknown = requests;
      const reader = await startTuiSession({
        boot,
        args: boot.resolve(parseCommonArgs(["--resume", reviewFile])),
        terminal: () => new VirtualTerminal(60, 24),
        onExit() {},
      });
      try {
        const before = EventLog.load(reviewFile).events;
        expect(before.filter((e) => e.type === "tool/unresolved")).toHaveLength(1);
        expect(requests).toBe(requestsBeforeUnknown);
        expect(existsSync(join(dir, "never-write.txt"))).toBe(false);
        await reader.app().command("/edit retry");
        await reader.app().command("/compact");
        await reader.app().submit("must not run before preparation");
        expect(EventLog.load(reviewFile).events).toEqual(before);
      } finally {
        await reader.close();
      }
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("输入快照:重启保留草稿,已入日志去重,关闭保存仍保留内存,失败可重试", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-inputs-"));
    const file = join(dir, "s.jsonl");
    const sidecar = join(dir, "s.inputs.json");
    try {
      const inputs = new SessionInputs(file, true);
      inputs.read([]);
      const draftImage = { ...testImage };
      const draftImages = [draftImage];
      inputs.setDraft("draft\n第二行", draftImages);
      draftImage.name = "changed by draft caller";
      draftImages.push({ ...testImage });
      const draftId = inputs.draftId;
      const pendingImage = { ...testImage };
      const pendingImages = [pendingImage];
      inputs.setPending([
        { id: "queued", text: "wait", deliverAs: "followUp", paused: false, images: pendingImages },
      ]);
      pendingImage.name = "changed by queue caller";
      inputs.configure(true); // 重新保存仍应来自内部持有的图片快照。
      inputs.flush();
      expect(new SessionInputs(file, true).read([])).toMatchObject({
        draft: { text: "draft\n第二行", images: [testImage] },
        pending: [{ id: "queued", images: [testImage] }],
      });
      const delivered = new SessionInputs(file, true);
      expect(
        delivered.read([
          { type: "user/message", at: "", text: "wait", inputId: "queued" },
          { type: "user/message", at: "", text: "draft", inputId: draftId },
        ]),
      ).toMatchObject({ draft: { text: "" }, pending: [] });
      inputs.configure(false);
      expect(existsSync(sidecar)).toBe(false);
      expect(inputs.read([]).pending).toHaveLength(1);
      inputs.configure(true);
      expect(existsSync(sidecar)).toBe(true);
      rmSync(sidecar);
      mkdirSync(sidecar);
      inputs.setDraft("retry this draft");
      expect(() => inputs.flush()).toThrow();
      expect(inputs.error).toBeTruthy();
      expect(inputs.read([]).draft.text).toBe("retry this draft");
      rmdirSync(sidecar);
      inputs.flush();
      expect(inputs.error).toBeUndefined();
      expect(new SessionInputs(file, true).read([]).draft.text).toBe("retry this draft");
      inputs.setDraft("");
      inputs.setPending([]);
      expect(existsSync(sidecar)).toBe(false);
      expect(existsSync(`${sidecar}.tmp`)).toBe(false);
      inputs.detach();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("每个登记的设置恰好属于一个组成部分,有作用说明和推荐理由", () => {
    const keys = SETUP_SECTIONS.flatMap((s) => [...s.keys]);
    expect(keys.slice().sort()).toEqual(SETTINGS.map((d) => d.key).sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(SETUP_GUIDE).sort()).toEqual(keys.slice().sort());
    expect(defaultPreset().planReminder).toBe(0);
  });

  it("启动快照记录实际解析结果;false 和空数组不被缺省值覆盖", () => {
    const config: KernelConfig = {
      default: "p/m",
      providers: {},
      defaults: { prompt: { sections: [] }, facts: { slow: false }, planReminder: 4, model: "p/m" },
    };
    const args = applyPreset(parseCommonArgs(["--screen", "main"]), config);
    const snapshot = settingsFromArgs(args);
    expect(snapshot.screen).toBe("main");
    expect(snapshot.prompt?.sections).toEqual([]);
    expect(snapshot.facts?.slow).toBe(false);
    expect(snapshot.planReminder).toBe(4);
    expect(snapshot.model).toBe("p/m");
    for (const def of SETTINGS)
      expect(
        getSetting(snapshot, def.key) === undefined ||
          typeof getSetting(snapshot, def.key) !== "function",
      ).toBe(true);
  });

  it("方案快照只取注册字段;对象合并保留显式关闭和空列表", () => {
    const source = { ...defaultPreset(), providers: { private: {} }, apiKey: "fixture-only" };
    const snapshot = setupSnapshot(SETTINGS, (def) => getSetting(source, def.key));
    expect(snapshot).not.toHaveProperty("providers");
    expect(snapshot).not.toHaveProperty("apiKey");
    expect(
      mergeSetup(
        { prompt: { sections: ["role"], memory: true } },
        { prompt: { sections: [], memory: false } },
      ),
    ).toEqual({ prompt: { sections: [], memory: false } });
  });

  it("保存与加载方案真实落盘;重复名字不覆盖,现有设置不在启动时被重置", () => {
    const boot = fixture();
    expect(boot.resolve(parseCommonArgs([])).planReminder).toBe(8);
    boot.settings.savePreset?.("mine", { ...defaultPreset(), model: "p/m", foldLines: 11 });
    expect(boot.settings.listPresets?.().map((p) => p.name)).toContain("mine");
    expect(() => boot.settings.savePreset?.("mine", { foldLines: 99 })).toThrow("already exists");
    boot.settings.usePreset?.("mine");
    const config = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as KernelConfig;
    expect(config.defaults?.foldLines).toBe(11);
    expect(config.defaults?.planReminder).toBe(0);
    expect(config.defaults?.maxSteps).toBeUndefined();
    expect(config.defaults?.systemPromptFile).toBe("instructions.md");
    expect(config.defaults?.approval).toEqual({ allow: [] });
    expect(boot.resolve(parseCommonArgs([])).foldLines).toBe(11);
    expect(boot.resolve(parseCommonArgs(["--preset", "small"])).planReminder).toBe(4);
    expect(() => boot.settings.savePreset?.("../bad", {})).toThrow("letters");
    const other = bootstrap();
    boot.settings.saveSetting?.("steering", "turn");
    other.settings.saveSetting?.("execution", "parallel");
    boot.settings.saveSetting?.("facts.slow", false);
    other.settings.saveSetting?.("facts.date", false);
    const merged = bootstrap().config;
    expect(merged.defaults).toMatchObject({
      steering: "turn",
      execution: "parallel",
      facts: { slow: false, date: false },
    });
    boot.settings.saveSettings?.({ compactionPrompt: "codex", compactionMaxTokens: 0 });
    expect(bootstrap().config.defaults).toMatchObject({
      compactionPrompt: "codex",
      compactionMaxTokens: 0,
      steering: "turn",
      execution: "parallel",
      facts: { slow: false, date: false },
    });
    boot.settings.savePreset?.("concurrent", { foldLines: 7 });
    expect(() => other.settings.savePreset?.("concurrent", { foldLines: 99 })).toThrow(
      "already exists",
    );
  });

  it("保存的无上限和自动选项在 --preset 与界面载入中一致,显式命令行仍优先", () => {
    const boot = fixture();
    const snapshot = setupSnapshot(SETTINGS, (def) => getSetting(defaultPreset(), def.key));
    snapshot.preservation = "auto";
    boot.settings.savePreset?.("automatic", snapshot);
    boot.settings.saveSetting?.("maxSteps", 21);
    boot.settings.saveSetting?.("effort", "high");
    boot.settings.saveSetting?.("preservation", "tokens 4000");
    boot.settings.saveSetting?.("model", "p/other");
    const restarted = bootstrap();
    const args = restarted.resolve(parseCommonArgs(["--preset", "automatic"]));
    expect(args.maxSteps).toBeUndefined();
    expect(args.effort).toBeUndefined();
    expect(args.preservation).toBe("auto");
    expect(args.model).toBeUndefined();
    expect(
      restarted.resolve(
        parseCommonArgs([
          "--preset",
          "automatic",
          "--max-steps",
          "3",
          "--effort",
          "low",
          "--model",
          "p/m",
        ]),
      ),
    ).toMatchObject({ maxSteps: 3, effort: "low", model: "p/m" });
    restarted.settings.usePreset?.("automatic");
    const loaded = restarted.resolve(parseCommonArgs([]));
    expect(loaded.maxSteps).toBe(args.maxSteps);
    expect(loaded.effort).toBe(args.effort);
    expect(loaded.preservation).toBe(args.preservation);
    expect(loaded.model).toBe(args.model);
  });

  it("无效模型不写入默认值或方案,合法的自定义模型不需要凭据也可保存", () => {
    const boot = fixture();
    const original = readFileSync(DEFAULT_CONFIG_PATH, "utf8");
    expect(() => boot.settings.saveSetting?.("model", "unknown-provider/m")).toThrow(
      "unknown provider",
    );
    expect(() => boot.settings.savePreset?.("invalid", { model: "unknown-provider/m" })).toThrow(
      "unknown provider",
    );
    expect(readFileSync(DEFAULT_CONFIG_PATH, "utf8")).toBe(original);
    boot.settings.saveSetting?.("model", "p/custom-model");
    expect(boot.config.defaults?.model).toBe("p/custom-model");
  });

  it("存储失败不改变内存中的默认值或方案,恢复磁盘后可以重试", () => {
    const boot = fixture();
    const original = readFileSync(DEFAULT_CONFIG_PATH, "utf8");
    // 测试独占的临时配置路径,用同名空目录模拟不可写入的配置文件。
    rmSync(DEFAULT_CONFIG_PATH);
    mkdirSync(DEFAULT_CONFIG_PATH);
    try {
      expect(() => boot.settings.saveSetting?.("planReminder", 0)).toThrow();
      expect(boot.config.defaults?.planReminder).toBe(8);
      expect(() => boot.settings.savePreset?.("failed", {})).toThrow();
      expect(boot.config.presets).not.toHaveProperty("failed");
      expect(() => boot.settings.usePreset?.("recommended")).toThrow();
      expect(boot.config.defaults?.planReminder).toBe(8);
    } finally {
      rmdirSync(DEFAULT_CONFIG_PATH);
      writeFileSync(DEFAULT_CONFIG_PATH, original);
    }
    boot.settings.saveSetting?.("planReminder", 0);
    expect(boot.config.defaults?.planReminder).toBe(0);
  });
});
