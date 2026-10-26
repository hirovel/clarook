// MCP 客户端:JSON-RPC 2.0 over stdio(一行一条)或 Streamable HTTP(一条消息一个 POST)。
// 双时代:先按 2026-07-28 发 server/discover(每个请求自带 _meta 版本与能力,没有握手);
// 服务器不认就回退 2025-06-18 的 initialize 握手。只做 tools/list、tools/call 与取消,不做 OAuth、resources、prompts。
// 每条收发的消息都交给 onRpc,检视器据此可见;stderr 逐行交给 onLog,不当错误。
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { sseData } from "../../src/providers/sse.js";
import { stopProcessTree } from "../process-tree.js";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-06-18";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const UNSUPPORTED_VERSION = -32022;

export type McpTransportConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> };

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpToolDef = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: string };

export type McpCallResult = {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
};

export type McpConnectInfo = {
  era: "modern" | "legacy";
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
};

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** 请求已经交给传输层,但没有收到可确认结果的协议应答。 */
export class McpOutcomeUnknownError extends Error {}

export type McpClientOptions = {
  clientVersion?: string;
  /** 我们愿意说的版本,优先级从前到后。 */
  protocolVersions?: string[];
  /** 单个请求的超时毫秒数(工具调用可另给)。 */
  requestTimeoutMs?: number;
  onRpc?: (direction: "send" | "receive", message: JsonRpcMessage) => void;
  /** 请求结束后释放适配器持有的调用归属,包含取消、超时和传输失败。 */
  onRequestSettled?: (id: number) => void;
  onLog?: (line: string) => void;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  /** 只透传这些环境变量给 stdio 子进程(加上配置里显式给的)。 */
  envWhitelist?: string[];
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

const DEFAULT_ENV_WHITELIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "ComSpec",
  "PATHEXT",
  "LANG",
];

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private child: ChildProcess | undefined;
  private era: "modern" | "legacy" = "modern";
  private version = MODERN_VERSION;
  private sessionId: string | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    readonly name: string,
    private readonly transport: McpTransportConfig,
    private readonly opts: McpClientOptions = {},
  ) {}

  get isHttp(): boolean {
    return "url" in this.transport;
  }

  get protocolVersion(): string {
    return this.version;
  }

  get currentEra(): "modern" | "legacy" {
    return this.era;
  }

  /** 连接并判定时代。startupTimeoutMs 内没有任何应答按旧版处理,再失败才算失败。 */
  async connect(startupTimeoutMs = 10000): Promise<McpConnectInfo> {
    if (!this.isHttp) this.spawnChild();
    const versions = this.opts.protocolVersions ?? [MODERN_VERSION, LEGACY_VERSION];
    this.version = versions[0] ?? MODERN_VERSION;
    this.era = "modern";
    let discover: unknown;
    try {
      discover = await this.request("server/discover", {}, startupTimeoutMs);
    } catch (err) {
      if (err instanceof McpProtocolError && err.code === UNSUPPORTED_VERSION) {
        const supported = (err.data as { supported?: string[] } | undefined)?.supported ?? [];
        const pick = versions.find((v) => supported.includes(v) && v !== LEGACY_VERSION);
        if (!pick) return this.legacyHandshake(startupTimeoutMs);
        this.version = pick;
        discover = await this.request("server/discover", {}, startupTimeoutMs);
      } else {
        // 其它错误或超时:按 spec,一律当旧版回退,不绑定具体错误码。
        return this.legacyHandshake(startupTimeoutMs);
      }
    }
    const d = discover as {
      supportedVersions?: string[];
      instructions?: string;
      _meta?: Record<string, unknown>;
    };
    const supported = d.supportedVersions ?? [];
    const pick = versions.find((v) => supported.includes(v) && v !== LEGACY_VERSION);
    if (pick) this.version = pick;
    const serverInfo = d._meta?.[META_SERVER_INFO] as McpConnectInfo["serverInfo"];
    return {
      era: "modern",
      protocolVersion: this.version,
      ...(serverInfo && { serverInfo }),
      ...(d.instructions && { instructions: d.instructions }),
    };
  }

  private async legacyHandshake(timeoutMs: number): Promise<McpConnectInfo> {
    this.era = "legacy";
    this.version = LEGACY_VERSION;
    const result = (await this.request(
      "initialize",
      {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: { name: "clarook", version: this.opts.clientVersion ?? "0.1.0" },
      },
      timeoutMs,
    )) as {
      protocolVersion?: string;
      serverInfo?: McpConnectInfo["serverInfo"];
      instructions?: string;
    };
    // 服务器回的版本不在我们清单里也先接受并记下:tools 的形状在这几版之间没变。
    if (result.protocolVersion) this.version = result.protocolVersion;
    await this.notify("notifications/initialized", {});
    return {
      era: "legacy",
      protocolVersion: this.version,
      ...(result.serverInfo && { serverInfo: result.serverInfo }),
      ...(result.instructions && { instructions: result.instructions }),
    };
  }

  /** 全部工具,跟着 nextCursor 翻到底。 */
  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = (await this.request("tools/list", cursor !== undefined ? { cursor } : {})) as {
        tools?: McpToolDef[];
        nextCursor?: string;
      };
      out.push(...(r.tools ?? []));
      if (r.nextCursor === undefined) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  async callTool(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const r = (await this.request(
      "tools/call",
      { name, arguments: args ?? {} },
      opts.timeoutMs,
      opts.signal,
      name,
    )) as McpCallResult;
    return { ...r, content: Array.isArray(r.content) ? r.content : [] };
  }

  private params(p: unknown): unknown {
    if (this.era === "legacy") return p;
    return {
      ...(p as Record<string, unknown>),
      _meta: {
        [META_VERSION]: this.version,
        [META_CAPS]: {},
        [META_INFO]: { name: "clarook", version: this.opts.clientVersion ?? "0.1.0" },
      },
    };
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs = this.opts.requestTimeoutMs ?? 60000,
    signal?: AbortSignal,
    toolName?: string,
  ): Promise<unknown> {
    if (signal?.aborted)
      throw new Error(`mcp ${this.name}: ${method} aborted before sending; not executed`);
    if (this.closed) throw new Error(`mcp ${this.name}: connection closed`);
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params: this.params(params) };
    return new Promise<unknown>((resolve, reject) => {
      let dispatched = false;
      const transport = new AbortController();
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        this.opts.onRequestSettled?.(id);
        transport.abort();
      };
      const cancel = (reason: string) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.reject(new Error(`mcp ${this.name}: ${method} ${reason}`));
        if (dispatched)
          void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => {});
      };
      const onAbort = () => cancel("aborted");
      const timer = setTimeout(() => cancel(`timed out after ${timeoutMs}ms`), timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          if (!this.pending.has(id)) return;
          finish();
          resolve(v);
        },
        reject: (e) => {
          if (!this.pending.has(id)) return;
          finish();
          reject(
            method === "tools/call" && dispatched && !(e instanceof McpProtocolError)
              ? new McpOutcomeUnknownError(e.message, { cause: e })
              : e,
          );
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send(message, toolName, transport.signal, () => {
        dispatched = true;
      }).catch((err) => this.pending.get(id)?.reject(err as Error));
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    await this.send(
      { jsonrpc: "2.0", method, params: this.params(params) },
      undefined,
      AbortSignal.timeout(this.opts.requestTimeoutMs ?? 60000),
    );
  }

  private async send(
    message: JsonRpcMessage,
    toolName?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<void> {
    signal?.throwIfAborted();
    const child = this.child;
    if (!this.isHttp && !child?.stdin?.writable)
      throw new Error(`mcp ${this.name}: process is not running`);
    const body = JSON.stringify(message);
    this.opts.onRpc?.("send", message);
    signal?.throwIfAborted();
    onDispatch?.();
    if (this.isHttp) return this.sendHttp(message, body, toolName, signal);
    child?.stdin?.write(`${body}\n`);
  }

  private async sendHttp(
    message: JsonRpcMessage,
    body: string,
    toolName?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const t = this.transport as { url: string; headers?: Record<string, string> };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.version,
      ...(this.era === "modern" && message.method && { "mcp-method": message.method }),
      ...(this.era === "modern" && toolName && { "mcp-name": toolName }),
      ...(this.sessionId && { "mcp-session-id": this.sessionId }),
      ...t.headers,
    };
    const res = await fetch(t.url, { method: "POST", headers, body, ...(signal && { signal }) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (message.id === undefined) {
      await res.body?.cancel().catch(() => {});
      return;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: JsonRpcMessage | undefined;
      try {
        parsed = JSON.parse(text) as JsonRpcMessage;
      } catch {
        // 不是 JSON 的错误体
      }
      if (parsed?.error) {
        this.receive(parsed);
        return;
      }
      this.pending
        .get(message.id as number)
        ?.reject(new Error(`mcp ${this.name}: HTTP ${res.status} ${text.slice(0, 200)}`));
      return;
    }
    if (ct.startsWith("text/event-stream")) {
      if (!res.body) throw new Error(`mcp ${this.name}: empty SSE response`);
      for await (const data of sseData(res.body, { stallTimeoutMs: 0 })) {
        this.receive(JSON.parse(data) as JsonRpcMessage);
        // 匹配结果已经完成请求并撤销传输;不等待服务器关闭长连接。
        if (!this.pending.has(message.id as number)) return;
      }
      return;
    }
    const text = await res.text();
    const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.receive(m);
  }

  private spawnChild(): void {
    const t = this.transport as {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    };
    const env: Record<string, string> = {};
    for (const k of this.opts.envWhitelist ?? DEFAULT_ENV_WHITELIST) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, t.env ?? {});
    const child = spawn(t.command, t.args ?? [], {
      cwd: t.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(t.command),
    });
    this.child = child;
    child.on("error", (err) => this.failAll(new Error(`mcp ${this.name}: ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.failAll(
        new Error(
          `mcp ${this.name}: process exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
        ),
      );
      this.opts.onExit?.(code, signal);
    });
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          this.opts.onLog?.(`[stdout, not JSON-RPC] ${line}`);
          return;
        }
        this.receive(msg);
      });
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => this.opts.onLog?.(line));
    }
  }

  private receive(msg: JsonRpcMessage): void {
    this.opts.onRpc?.("receive", msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      if (msg.error)
        p.reject(
          new McpProtocolError(
            msg.error.code,
            `mcp ${this.name}: ${msg.error.message}`,
            msg.error.data,
          ),
        );
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      if (msg.id !== undefined) {
        // 服务器→客户端的请求(sampling、roots 之类)一律不支持。
        void this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "method not supported by this client" },
        }).catch(() => {});
        return;
      }
      this.opts.onNotification?.(msg.method, msg.params);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** 关闭:先让 stdio 服务处理 EOF,仍在运行时停止整个进程树。 */
  close(): Promise<void> {
    if (!this.closing)
      this.closing = this.stop().catch((error) => {
        this.closing = undefined;
        throw error;
      });
    return this.closing;
  }

  private async stop(): Promise<void> {
    this.closed = true;
    this.failAll(new Error(`mcp ${this.name}: closed`));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      let t1: NodeJS.Timeout | undefined;
      let t2: NodeJS.Timeout | undefined;
      let finished = false;
      const done = (error?: Error) => {
        if (finished) return;
        finished = true;
        if (t1) clearTimeout(t1);
        if (t2) clearTimeout(t2);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => done();
      child.once("exit", onExit);
      try {
        child.stdin?.end();
      } catch {
        // 已关闭
      }
      t1 = setTimeout(() => {
        try {
          stopProcessTree(child, process.platform !== "win32");
        } catch (error) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          done(new Error(`mcp ${this.name}: ${(error as Error).message}`));
        }
      }, 1000);
      t2 = setTimeout(() => {
        done(
          new Error(
            `mcp ${this.name}: process did not exit after stop; children may still be running`,
          ),
        );
      }, 2000);
    });
  }
}
