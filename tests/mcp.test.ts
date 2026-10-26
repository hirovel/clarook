// MCP 客户端与桥接:双时代探测、分页、命名、白黑名单、isError 与协议错误、图片落盘、stderr 事件、
// list_changed 刷新、启动失败与 required、HTTP 传输、审批规则、配置合并与变量展开。
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventViewLines } from "../cli/inspector-events.js";
import {
  bridgedName,
  connectMcpServers,
  contentToText,
  type McpEvent,
  mcpEvent,
  toolAllowed,
} from "../cli/mcp/bridge.js";
import type { JsonRpcMessage, McpClientOptions } from "../cli/mcp/client.js";
import { McpClient } from "../cli/mcp/client.js";
import { expandVars, loadMcpServers, type ResolvedServer } from "../cli/mcp/config.js";
import { McpConnections } from "../cli/mcp/connections.js";
import { projectMcpReview, projectMcpTrusted, trustProjectMcp } from "../cli/mcp/trust.js";
import { forkSession } from "../cli/sessions.js";
import { Agent } from "../src/agent.js";
import { decide } from "../src/approval.js";
import type { AgentEvent } from "../src/events.js";
import { toolOutput } from "../src/exchange.js";
import { priorFailures } from "../src/facts.js";
import { EventLog } from "../src/log.js";
import { Recording } from "../src/recording.js";
import { recordUnresolvedCalls, unresolvedCalls } from "../src/recovery.js";
import type { Tool } from "../src/tools.js";
import { createLogic } from "./helpers/mcp-server.mjs";

const helper = resolve("tests/helpers/mcp-server.mjs");
const tempDirs: string[] = [];
const recordedLogs: EventLog[] = [];
afterAll(() => {
  for (const log of recordedLogs) log.recording?.dispose();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const ctx = { signal: new AbortController().signal, callId: "call_1" } as never;
const mcpEvents = (events: readonly AgentEvent[]): McpEvent[] =>
  events.flatMap((e) => {
    const m = mcpEvent(e);
    return m ? [m] : [];
  });

function stdioServer(
  name: string,
  args: string[],
  extra: Partial<ResolvedServer["config"]> = {},
): ResolvedServer {
  return {
    name,
    config: { command: process.execPath, args: [helper, ...args], ...extra },
    missing: [],
    source: "test",
  };
}

const find = (tools: Tool[], name: string) => tools.find((t) => t.name === name) as Tool;

describe("stdio · modern", () => {
  it("关闭失败的连接仍留在池中,退出时可以重试清理", async () => {
    let attempts = 0;
    const fake = {
      async connect() {
        return { era: "modern", protocolVersion: "2026-07-28" };
      },
      async listTools() {
        return [];
      },
      async close() {
        attempts++;
        if (attempts === 1) throw new Error("first close failed");
      },
    } as unknown as McpClient;
    const pool = new McpConnections();
    const { connection } = await pool.acquire(stdioServer("cleanup", []), {
      log: new EventLog(),
      createClient: () => fake,
    });
    await expect(pool.release(connection)).rejects.toThrow("first close failed");
    await expect(pool.close()).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    let startupStops = 0;
    const failedStartup = {
      async connect(): Promise<never> {
        throw new Error("startup failed");
      },
      async close() {
        startupStops++;
        if (startupStops === 1) throw new Error("startup cleanup failed");
      },
    } as unknown as McpClient;
    const pending = new McpConnections();
    await expect(
      pending.acquire(stdioServer("startup", []), {
        log: new EventLog(),
        createClient: () => failedStartup,
      }),
    ).rejects.toThrow(/startup cleanup failed/);
    await expect(pending.close()).resolves.toBeUndefined();
    expect(startupStops).toBe(2);
  });

  it.skipIf(process.platform !== "win32")(
    "关闭 cmd 包装的 MCP 时也停止其服务器进程",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "clarook-mcp-tree-"));
      tempDirs.push(dir);
      const script = join(dir, "server.mjs");
      const wrapper = join(dir, "server.cmd");
      const pidFile = join(dir, "server.pid");
      writeFileSync(
        script,
        `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], String(process.pid));
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "server/discover")
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { supportedVersions: ["2026-07-28"] } }) + "\\n");
});
setInterval(() => {}, 1000);
`,
      );
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" "${pidFile}"\r\n`);
      const client = new McpClient("tree", { command: wrapper });
      let pid = 0;
      try {
        await client.connect(3000);
        pid = Number(readFileSync(pidFile, "utf8"));
        let closeError: unknown;
        try {
          await client.close();
        } catch (error) {
          closeError = error;
        }
        if (closeError) expect((closeError as Error).message).toMatch(/may still be running/);
        else expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await client.close().catch(() => {});
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already stopped */
          }
        }
      }
    },
    10000,
  );

  it("server/discover 定时代;分页拼全;命名;echo / boom / proto / image;stderr 进 mcp/log;关闭", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-mcp-"));
    tempDirs.push(dir);
    const log = new EventLog(join(dir, "session.jsonl"));
    recordedLogs.push(log);
    const tools: Tool[] = [];
    const connections = new McpConnections();
    const bridge = await connectMcpServers(
      [stdioServer("fake", ["--era", "modern", "--tools", "3", "--page", "2", "--stderr-noise"])],
      { log, tools, artifactsDir: dir, connections },
    );
    const [s] = bridge.statuses();
    expect(s).toMatchObject({
      phase: "ready",
      era: "modern",
      protocolVersion: "2026-07-28",
      toolCount: 7,
    });
    expect(s?.serverInfo?.name).toBe("fake");
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["boom", "echo", "image", "proto", "t1", "t2", "t3"].map((n) => `mcp__fake__${n}`).sort(),
    );
    const ev = mcpEvents(log.events);
    const lists = ev.filter(
      (m) => m.kind === "rpc" && m.direction === "send" && m.method === "tools/list",
    );
    expect(lists).toHaveLength(4);
    expect(ev.some((m) => m.kind === "log" && m.line === "this is not an error")).toBe(true);
    // 内核只有一种 ext/event;MCP 的四种都装在 payload 里,内核事件表没有 mcp 字样。
    expect(log.events.every((e) => !e.type.startsWith("mcp"))).toBe(true);
    expect(ev.find((m) => m.kind === "server" && m.phase === "ready")).toMatchObject({
      listed: 7,
      toolCount: 7,
    });

    expect(await find(tools, "mcp__fake__echo").execute({ text: "hi" }, ctx)).toBe("echo: hi");
    const captureDir = mkdtempSync(join(tmpdir(), "clarook-mcp-output-"));
    tempDirs.push(captureDir);
    const captureLog = new EventLog(join(captureDir, "session.jsonl"));
    try {
      const output = toolOutput(captureLog, "long-echo", "mcp__fake__echo");
      if (!output) throw new Error("Recording output unavailable");
      const long = await find(tools, "mcp__fake__echo").execute(
        { text: `${"x".repeat(100010)}END_SENTINEL` },
        { signal: new AbortController().signal, output },
      );
      await captureLog.checkpoint();
      expect(long).toContain(`full raw MCP result: ${output.path}`);
      expect(long).not.toContain("END_SENTINEL");
      expect(readFileSync(output.path, "utf8")).toContain("END_SENTINEL");
      await log.checkpoint();
      const rpc = mcpEvents(log.events).find(
        (event) => event.kind === "rpc" && event.direction === "receive" && event.truncated,
      );
      if (rpc?.kind !== "rpc" || !rpc.bodyRef || !log.recording)
        throw new Error("MCP RPC attachment missing");
      expect(rpc.bodyRef?.bytes).toBeGreaterThan(100000);
      expect(log.recording.read(rpc.bodyRef)).toContain("END_SENTINEL");
      const index = log.events.findIndex(
        (event) =>
          event.type === "ext/event" &&
          event.source === "mcp" &&
          event.kind === "rpc" &&
          (event.payload.bodyRef as { file?: string } | undefined)?.file === rpc.bodyRef?.file,
      );
      expect(eventViewLines(log.events, index, log.recording.directory).join("\n")).toContain(
        join(log.recording.directory, rpc.bodyRef.file),
      );
      const fork = forkSession(log.events, log.events.length, dir, log.recording);
      expect(new Recording(fork.file).read(rpc.bodyRef)).toContain("END_SENTINEL");
    } finally {
      captureLog.recording?.dispose();
    }
    await expect(find(tools, "mcp__fake__boom").execute({}, ctx)).rejects.toThrow(
      "boom failed on purpose",
    );
    await expect(find(tools, "mcp__fake__proto").execute({}, ctx)).rejects.toThrow(
      /bad params for proto/,
    );
    const img = await find(tools, "mcp__fake__image").execute({}, ctx);
    expect(img).toContain("here is a picture");
    expect(img).toContain("saved to");
    expect(readdirSync(dir)).toContain("call_1-1.png");
    const nextLog = new EventLog();
    const nextTools: Tool[] = [];
    const servers = [
      stdioServer("fake", ["--era", "modern", "--tools", "3", "--page", "2", "--stderr-noise"]),
    ];
    const next = await connectMcpServers(servers, {
      log: nextLog,
      tools: nextTools,
      artifactsDir: join(dir, "next"),
      connections,
      activate: false,
    });
    expect(next.statuses()[0]?.connection).toBe("reused");
    await expect(
      connectMcpServers(
        [
          ...servers,
          {
            name: "broken",
            config: { command: "clarook-no-such-command-xyz", required: true },
            missing: [],
            source: "test",
          },
        ],
        { log: new EventLog(), tools: [], connections, activate: false },
      ),
    ).rejects.toThrow(/required but failed/);
    expect(await find(tools, "mcp__fake__echo").execute({ text: "still alive" }, ctx)).toBe(
      "echo: still alive",
    );
    next.activate();
    await bridge.close();
    expect(bridge.statuses()[0]?.phase).toBe("closed");
    const oldCount = log.events.length;
    expect(await find(nextTools, "mcp__fake__image").execute({}, ctx)).toContain(join(dir, "next"));
    expect(log.events).toHaveLength(oldCount);
    expect(readdirSync(join(dir, "next"))).toEqual(["call_1-1.png"]);
    const separate = await connectMcpServers(servers, {
      log: new EventLog(),
      tools: [],
      connections,
      reconnect: ["fake"],
    });
    expect(separate.statuses()[0]?.connection).toBe("reconnected");
    await separate.close();
    expect(await find(nextTools, "mcp__fake__echo").execute({ text: "independent" }, ctx)).toBe(
      "echo: independent",
    );
    await next.close();
    await connections.close();
  });

  it("legacy:initialize 握手;第一次调用后 list_changed → 工具表原地刷新并记 mcp/tools", async () => {
    const log = new EventLog();
    const tools: Tool[] = [];
    const bridge = await connectMcpServers(
      [stdioServer("old", ["--era", "legacy", "--tools", "1", "--list-changed"])],
      { log, tools },
    );
    let sent: string[] = [];
    const agent = new Agent({
      log,
      tools: () => tools,
      provider: {
        model: "fake",
        async complete(_messages, definitions) {
          sent = definitions.map((definition) => definition.name);
          return { text: "done", toolCalls: [], stopReason: "end" };
        },
      },
    });
    expect(bridge.statuses()[0]).toMatchObject({
      phase: "ready",
      era: "legacy",
      protocolVersion: "2025-06-18",
    });
    expect(mcpEvents(log.events).some((m) => m.kind === "rpc" && m.method === "initialize")).toBe(
      true,
    );
    expect(await find(tools, "mcp__old__t1").execute({ x: 1 }, ctx)).toBe('t1 got {"x":1}');
    for (let i = 0; i < 50 && !tools.some((t) => t.name === "mcp__old__t_new"); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(tools.some((t) => t.name === "mcp__old__t_new")).toBe(true);
    const change = mcpEvents(log.events).find(
      (m) => m.kind === "tools" && m.added.includes("mcp__old__t_new"),
    );
    expect(change).toMatchObject({ removed: [], total: 6 });
    await agent.prompt("Use the refreshed tool catalog.");
    expect(sent).toContain("mcp__old__t_new");
    await bridge.close();
  });

  it("enabledTools / disabledTools;启动失败只记事件,required 才抛;进程崩溃 → closed", async () => {
    const log = new EventLog();
    const tools: Tool[] = [];
    const bridge = await connectMcpServers(
      [
        stdioServer("f", ["--era", "modern", "--tools", "3"], {
          enabledTools: ["t*"],
          disabledTools: ["t2"],
        }),
        {
          name: "gone",
          config: { command: "clarook-no-such-command-xyz" },
          missing: ["TOKEN"],
          source: "test",
        },
        stdioServer("crash", ["--era", "modern", "--tools", "1", "--crash-after", "1"]),
      ],
      { log, tools },
    );
    expect(tools.filter((t) => t.name.startsWith("mcp__f__")).map((t) => t.name)).toEqual([
      "mcp__f__t1",
      "mcp__f__t3",
    ]);
    const gone = bridge.statuses().find((s) => s.name === "gone");
    expect(gone?.phase).toBe("failed");
    expect(gone?.error).toBeTruthy();
    expect(
      mcpEvents(log.events).find(
        (m) => m.kind === "server" && m.server === "gone" && m.phase === "starting",
      ),
    ).toMatchObject({ warning: "unset variables kept as-is: TOKEN" });
    await find(tools, "mcp__crash__t1").execute({}, ctx);
    for (
      let i = 0;
      i < 50 && bridge.statuses().find((s) => s.name === "crash")?.phase !== "closed";
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    expect(bridge.statuses().find((s) => s.name === "crash")).toMatchObject({ phase: "closed" });
    await expect(find(tools, "mcp__crash__t1").execute({}, ctx)).rejects.toThrow(
      /process|closed|not running/,
    );
    await bridge.close();

    await expect(
      connectMcpServers(
        [
          {
            name: "must",
            config: { command: "clarook-no-such-command-xyz", required: true },
            missing: [],
            source: "t",
          },
        ],
        { log: new EventLog(), tools: [] },
      ),
    ).rejects.toThrow(/required but failed/);
  });
});

describe("Streamable HTTP · modern", () => {
  let server: Server;
  let url = "";
  const seen: Record<string, string>[] = [];
  let intercept: ((message: JsonRpcMessage, res: ServerResponse) => boolean) | undefined;
  beforeAll(async () => {
    const handle = createLogic({ era: "modern", tools: 1 });
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push(req.headers as Record<string, string>);
        const msg = JSON.parse(body);
        if (intercept?.(msg, res)) return;
        const out = handle(msg);
        if (msg.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        // 一半走 JSON,一半走 SSE:客户端两种都要吃。
        if (msg.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(out.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out[0]));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => server.close());

  it("POST 每条消息;头带版本与方法;JSON 与 SSE 两种响应都能读;Authorization 不进事件", async () => {
    const log = new EventLog();
    const tools: Tool[] = [];
    const bridge = await connectMcpServers(
      [
        {
          name: "web",
          config: { url, headers: { Authorization: "Bearer secret-token" } },
          missing: [],
          source: "t",
        },
      ],
      { log, tools },
    );
    expect(bridge.statuses()[0]).toMatchObject({
      phase: "ready",
      transport: "http",
      era: "modern",
    });
    expect(await find(tools, "mcp__web__echo").execute({ text: "via http" }, ctx)).toBe(
      "echo: via http",
    );
    const callsBeforeAbort = seen.filter((h) => h["mcp-method"] === "tools/call").length;
    await expect(
      find(tools, "mcp__web__echo").execute(
        { text: "must not be sent" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow(/aborted before sending; not executed/);
    expect(seen.filter((h) => h["mcp-method"] === "tools/call")).toHaveLength(callsBeforeAbort);
    const call = seen.find((h) => h["mcp-method"] === "tools/call");
    expect(call).toMatchObject({
      "mcp-protocol-version": "2026-07-28",
      "mcp-name": "echo",
      accept: "application/json, text/event-stream",
    });
    expect(JSON.stringify(log.events)).not.toContain("secret-token");
    await bridge.close();

    const client = new McpClient("framing", { url }, { requestTimeoutMs: 500 });
    try {
      for (const mode of ["crlf", "open", "invalid"] as const) {
        let disconnected!: () => void;
        const closed = new Promise<void>((resolve) => {
          disconnected = resolve;
        });
        intercept = (message, res) => {
          if (message.method !== "tools/call") return false;
          res.once("close", disconnected);
          res.writeHead(200, { "content-type": "text/event-stream" });
          const notification = JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {},
          });
          const result = JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: mode }] },
          });
          if (mode === "invalid") res.write("data: {broken}\n\n");
          else if (mode === "crlf") res.end(`data: ${notification}\r\n\r\ndata: ${result}\r\n\r\n`);
          else res.write(`data: ${notification}\n\ndata: ${result}\n\n`);
          return true;
        };
        const result = client.callTool("echo", { text: mode });
        if (mode === "invalid") await expect(result).rejects.toThrow(/JSON/);
        else expect((await result).content).toEqual([{ type: "text", text: mode }]);
        await closed;
      }
    } finally {
      intercept = undefined;
      await client.close();
    }
  });

  it("远端执行后超时、取消或断线:结果未知回喂,Esc 停止;释放 HTTP 等待且迟到结果不串会话", async () => {
    const connections = new McpConnections();
    const servers: ResolvedServer[] = [
      { name: "uncertain", config: { url, toolTimeoutMs: 500 }, missing: [], source: "test" },
    ];
    try {
      for (const mode of ["timeout", "cancel", "disconnect"] as const) {
        let received!: () => void;
        let disconnected!: () => void;
        const arrived = new Promise<void>((resolve) => {
          received = resolve;
        });
        const closed = new Promise<void>((resolve) => {
          disconnected = resolve;
        });
        let replyLate = () => {};
        let executions = 0;
        intercept = (message, res) => {
          if (
            message.method !== "tools/call" ||
            (message.params as { arguments: { text: string } }).arguments.text !== mode
          )
            return false;
          executions++;
          res.once("close", disconnected);
          replyLate = () =>
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: "late remote completion" }] },
              }),
            );
          received();
          if (mode === "disconnect") res.destroy();
          return true;
        };
        const log = new EventLog();
        const tools: Tool[] = [];
        const bridge = await connectMcpServers(servers, { log, tools, connections });
        let requests = 0;
        const call = { id: mode, name: "mcp__uncertain__echo", args: { text: mode } };
        const agent = new Agent({
          log,
          tools,
          provider: {
            model: "fake",
            async complete(messages) {
              if (requests++ === 0) return { text: "", toolCalls: [call], stopReason: "tool" };
              const response = messages.find((m) => m.role === "tool");
              expect(response?.content).toContain("Execution outcome unknown:");
              expect(response?.content).toContain("Check the actual state");
              return {
                text: "I will check the actual state before retrying.",
                toolCalls: [],
                stopReason: "end",
              };
            },
          },
        });
        const running = agent.prompt("Run the remote operation.");
        await arrived;
        if (mode === "cancel") agent.interrupt();
        await running;
        await closed;
        expect(requests).toBe(mode === "cancel" ? 1 : 2);
        expect(executions).toBe(1);
        const result = log.events.find((e) => e.type === "tool/result");
        expect(result).toMatchObject({ callId: mode, outcome: "unknown", isError: true });
        expect(result?.content).toContain(
          mode === "timeout" ? "timed out" : mode === "cancel" ? "aborted" : "fetch failed",
        );
        expect(priorFailures(log.events, call)).toBe(0);
        recordUnresolvedCalls(log);
        expect(log.events.some((e) => e.type === "tool/unresolved")).toBe(false);
        expect(unresolvedCalls(log.events)).toMatchObject([
          { call, result: { content: result?.content } },
        ]);
        const nextLog = new EventLog();
        const nextTools: Tool[] = [];
        const next = await connectMcpServers(servers, {
          log: nextLog,
          tools: nextTools,
          connections,
        });
        const oldLength = log.events.length;
        replyLate();
        expect(await find(nextTools, call.name).execute({ text: "next session" }, ctx)).toBe(
          "echo: next session",
        );
        expect(log.events).toHaveLength(oldLength);
        expect(JSON.stringify(nextLog.events)).not.toContain("late remote completion");
        await bridge.close();
        await next.close();
      }
    } finally {
      intercept = undefined;
      await connections.close();
    }
  });
});

describe("命名、白黑名单、内容转换、审批规则、配置", () => {
  it("一次性模式在未信任项目 MCP 时退出,不启动项目命令", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-mcp-gate-"));
    tempDirs.push(dir);
    const home = join(dir, "home");
    mkdirSync(home);
    const marker = join(dir, "started");
    const command = join(dir, "start.mjs");
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
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        default: "p/m",
        providers: {
          p: { protocol: "openai", baseUrl: "http://127.0.0.1:1", apiKey: "test", models: ["m"] },
        },
        defaults: {},
        presets: {},
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        resolve("cli/run.ts"),
        "test",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          CLAROOK_HOME: home,
          CLAROOK_CONFIG: join(home, "config.json"),
          CLAROOK_CREDENTIALS: join(home, "missing.json"),
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.stderr).toContain("Project MCP is not trusted");
    expect(result.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  it("项目 MCP 信任绑定目录和文件内容,修改命令后失效", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-mcp-trust-"));
    tempDirs.push(dir);
    const file = join(dir, ".mcp.json");
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { local: { command: "first", args: ["${TOKEN}"] } } }),
    );
    const first = projectMcpReview(dir);
    expect(first?.servers).toEqual([{ name: "local", command: "first", args: ["${TOKEN}"] }]);
    expect(first && projectMcpTrusted(first)).toBe(false);
    if (!first) throw new Error("expected project MCP review");
    trustProjectMcp(first);
    expect(projectMcpTrusted(first)).toBe(true);
    writeFileSync(file, JSON.stringify({ mcpServers: { local: { command: "changed" } } }));
    const changed = projectMcpReview(dir);
    expect(changed && projectMcpTrusted(changed)).toBe(false);
    expect(() => trustProjectMcp(first)).toThrow(/changed during review/);
  });

  it("bridgedName 稳定消歧,注册及刷新不混淆工具;toolAllowed;contentToText 各类型", async () => {
    const long = bridgedName("s", "x".repeat(200));
    expect(long).toHaveLength(128);
    expect(long).toMatch(/_[0-9a-f]{12}$/);
    expect(toolAllowed("get_x", ["get_*"], ["get_x"])).toBe(false);
    expect(toolAllowed("get_y", ["get_*"], ["get_x"])).toBe(true);
    expect(toolAllowed("anything", undefined, undefined)).toBe(true);
    expect(
      contentToText([
        { type: "text", text: "a" },
        { type: "resource", resource: { uri: "file:///x", text: "body" } },
        { type: "resource_link", uri: "https://x", name: "n" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    ).toBe(
      "a\n[resource file:///x]\nbody\n[resource link n https://x]\n[image image/png, 3 bytes, not saved]",
    );
    const definitions = new Map([
      ["a.b", ["a.b", "a_b"]],
      ["a_b", ["a.b", "a_b"]],
      ["a__b", ["c"]],
      ["a_", ["b"]],
      ["a", ["b__c", "_b"]],
    ]);
    const callbacks = new Map<string, McpClientOptions>();
    const tools: Tool[] = [];
    const log = new EventLog();
    const bridge = await connectMcpServers(
      [...definitions.keys()].map((name) => stdioServer(name, [])),
      {
        log,
        tools,
        createClient: (server, options) => {
          callbacks.set(server.name, options ?? {});
          return {
            async connect() {
              return { era: "modern", protocolVersion: "2026-07-28" };
            },
            async listTools() {
              return (
                definitions.get(server.name)?.map((name) => ({
                  name,
                  description: `${server.name}/${name}`,
                  inputSchema: { type: "object" },
                })) ?? []
              );
            },
            async callTool(name: string) {
              return { content: [{ type: "text", text: `${server.name}/${name}` }] };
            },
            async close() {},
          } as unknown as McpClient;
        },
      },
    );
    try {
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(8);
      const expectedNames = tools.map((tool) => tool.name).sort();
      let step = 0;
      const agent = new Agent({
        log: new EventLog(),
        tools,
        provider: {
          model: "fake",
          async complete(messages) {
            if (step++ === 0)
              return {
                text: "",
                toolCalls: tools.map((tool, i) => ({ id: `call-${i}`, name: tool.name, args: {} })),
                stopReason: "tool",
              };
            expect(
              messages
                .filter((message) => message.role === "tool")
                .map((message) => message.content),
            ).toEqual(tools.map((tool) => tool.description));
            return { text: "done", toolCalls: [], stopReason: "end" };
          },
        },
      });
      await agent.prompt("Use each registered tool.");
      definitions.set("a.b", ["a_b", "a.b"]);
      callbacks.get("a.b")?.onNotification?.("notifications/tools/list_changed", {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tools.map((tool) => tool.name).sort()).toEqual(expectedNames);
      expect(await find(tools, bridgedName("a_b", "a_b")).execute({}, ctx)).toBe("a_b/a_b");
      definitions.set("a.b", ["a_b", "a_b"]);
      callbacks.get("a.b")?.onNotification?.("notifications/tools/list_changed", {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tools.map((tool) => tool.name).sort()).toEqual(expectedNames);
      expect(
        mcpEvents(log.events).some(
          (event) => event.kind === "log" && event.line.includes("duplicate tool name"),
        ),
      ).toBe(true);
    } finally {
      await bridge.close();
    }
    expect(bridgedName("my server", "get/issue")).toMatch(
      /^mcp__my_server__get_issue_[0-9a-f]{12}$/,
    );
  });

  it("审批:mcp:<server>:<tool> 规则,mcp 通配整类;缺省问", () => {
    const call = (name: string) => ({ id: "c", name, args: {} });
    const cfg = { default: "ask" as const, allow: ["mcp:github:get_*"], deny: ["mcp:*:delete_*"] };
    expect(decide(call("mcp__github__get_issue"), cfg, "C:/w").verdict).toBe("allow");
    expect(decide(call("mcp__github__delete_repo"), cfg, "C:/w").verdict).toBe("deny");
    expect(decide(call("mcp__github__create_issue"), cfg, "C:/w")).toEqual({
      verdict: "ask",
      reason: "no rule for mcp__github__create_issue",
    });
    expect(decide(call("mcp__x__y"), { default: "ask", allow: ["mcp"] }, "C:/w").verdict).toBe(
      "allow",
    );
  });

  it("配置合并:.mcp.json 与 config.json 同名以后者为准;${VAR} 展开与缺失记录;enabled:false 跳过", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-mcpcfg-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a: { type: "stdio", command: "x", args: ["${TOKEN}", "${OPT:-dflt}"] },
          b: { url: "https://b" },
        },
      }),
    );
    const servers = loadMcpServers(
      {
        servers: {
          b: { url: "https://b2", headers: { Authorization: "Bearer ${TOKEN}" } },
          c: { command: "z", enabled: false },
        },
      },
      dir,
      { TOKEN: "tok" },
    );
    expect(servers.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(servers.find((s) => s.name === "a")?.config.args).toEqual(["tok", "dflt"]);
    expect(servers.find((s) => s.name === "b")).toMatchObject({
      config: { url: "https://b2", headers: { Authorization: "Bearer tok" } },
      source: "config.json",
    });
    expect(expandVars("${MISSING}/x", {})).toEqual({ value: "${MISSING}/x", missing: ["MISSING"] });
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });
});
