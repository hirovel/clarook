// 连接持有协议状态,会话持有日志和工具包装。引用归零才关闭,候选会话失败不影响原会话。
import { AsyncLocalStorage } from "node:async_hooks";
import { now } from "../../src/events.js";
import type { EventLog } from "../../src/log.js";
import type { McpEvent, McpServerStatus } from "./bridge.js";
import { McpClient, type McpClientOptions, type McpToolDef } from "./client.js";
import type { McpConfig, ResolvedServer } from "./config.js";

export type ConnectionOptions = {
  log: EventLog;
  mcp?: McpConfig;
  clientVersion?: string;
  createClient?: (server: ResolvedServer, opts: McpClientOptions) => McpClient;
};

export class Connection {
  readonly status: McpServerStatus;
  readonly client: McpClient;
  definitions: McpToolDef[] = [];
  readonly listeners = new Set<() => void>();
  references = 0;
  private active: { log: EventLog; owner: object } | undefined;
  private readonly scope = new AsyncLocalStorage<EventLog>();
  private readonly requests = new Map<number | string, EventLog>();
  private closing: Promise<void> | undefined;
  private refresh: Promise<void> | undefined;
  private refreshAgain = false;

  constructor(
    readonly key: string,
    readonly server: ResolvedServer,
    opts: ConnectionOptions,
  ) {
    this.active = { log: opts.log, owner: this };
    this.status = {
      name: server.name,
      phase: "failed",
      transport: server.config.url ? "http" : "stdio",
      toolCount: 0,
      ms: 0,
      missingVars: server.missing,
    };
    const clientOpts: McpClientOptions = {
      ...(opts.clientVersion && { clientVersion: opts.clientVersion }),
      ...(opts.mcp?.protocolVersions && { protocolVersions: opts.mcp.protocolVersions }),
      requestTimeoutMs: server.config.toolTimeoutMs ?? 60000,
      onRpc: (direction, message) => {
        const id = message.id;
        const response = direction === "receive" && !message.method && id !== undefined;
        const log =
          direction === "send"
            ? (this.scope.getStore() ?? this.active?.log)
            : response
              ? this.requests.get(id)
              : this.active?.log;
        if (direction === "send" && message.method && id !== undefined && log)
          this.requests.set(id, log);
        if (response) this.requests.delete(id);
        // 已结束请求的迟到响应与客户端的 pending 表一致丢弃,不串到后来激活的会话。
        if (!log) return;
        const body = JSON.stringify(message, (k, v) =>
          k.toLowerCase() === "authorization" ? "<redacted>" : v,
        );
        const limit = opts.mcp?.maxResultChars ?? 100000;
        const truncated = body.length > limit;
        const recording = log.recording;
        const stored = truncated
          ? recording?.open(`MCP ${server.name} ${direction} RPC`)
          : undefined;
        if (stored) {
          for (let start = 0; start < body.length; ) {
            let end = Math.min(start + 64 * 1024, body.length);
            if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1] ?? "")) end--;
            stored.write(body.slice(start, end));
            start = end;
          }
        }
        const end = /[\uD800-\uDBFF]/.test(body[limit - 1] ?? "") ? limit - 1 : limit;
        this.emit(
          {
            kind: "rpc",
            server: server.name,
            direction,
            ...(message.method && { method: message.method }),
            ...(id !== undefined && { id }),
            bytes: Buffer.byteLength(body),
            body: truncated ? `${body.slice(0, end)}…` : body,
            ...(truncated && { truncated: true }),
            ...(stored && { bodyRef: { ...stored.ref, bytes: stored.bytes } }),
          },
          log,
        );
      },
      onRequestSettled: (id) => this.requests.delete(id),
      onLog: (line) => this.emit({ kind: "log", server: server.name, line }),
      onNotification: (method) => {
        if (method === "notifications/tools/list_changed") void this.refreshTools();
      },
      onExit: (code, signal) => {
        if (this.status.phase !== "ready") return;
        this.status.phase = "closed";
        this.status.error = `process exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
        this.emit({
          kind: "server",
          server: server.name,
          phase: "closed",
          transport: this.status.transport,
          error: this.status.error,
        });
      },
    };
    const c = server.config;
    const transport = c.url
      ? { url: c.url, ...(c.headers && { headers: c.headers }) }
      : {
          command: c.command ?? "",
          ...(c.args && { args: c.args }),
          ...(c.env && { env: c.env }),
          ...(c.cwd && { cwd: c.cwd }),
        };
    this.client =
      opts.createClient?.(server, clientOpts) ?? new McpClient(server.name, transport, clientOpts);
  }

  /** 激活归属是 bridge 生命周期;同一日志的新旧 bridge 不能互相解除。 */
  activate(owner: object, log: EventLog): void {
    this.active = { owner, log };
  }

  deactivate(owner: object): void {
    if (this.active?.owner === owner) this.active = undefined;
  }

  emit(event: McpEvent, log = this.active?.log): void {
    const { kind, ...payload } = event;
    log?.append({ type: "ext/event", at: now(), source: "mcp", kind, payload });
  }

  async connect(): Promise<void> {
    const started = Date.now();
    const { name, config, missing } = this.server;
    this.emit({
      kind: "server",
      server: name,
      phase: "starting",
      transport: this.status.transport,
      ...(missing.length && { warning: `unset variables kept as-is: ${missing.join(", ")}` }),
    });
    try {
      if (!config.url && !config.command)
        throw new Error("server needs either command (stdio) or url (http)");
      const info = await this.client.connect(config.startupTimeoutMs ?? 10000);
      this.definitions = await this.client.listTools();
      Object.assign(this.status, info, {
        phase: "ready",
        toolCount: this.definitions.length,
        ms: Date.now() - started,
      });
    } catch (error) {
      this.status.error = (error as Error).message;
      this.status.ms = Date.now() - started;
      this.emit({
        kind: "server",
        server: name,
        phase: "failed",
        transport: this.status.transport,
        error: this.status.error,
        ms: this.status.ms,
      });
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `mcp ${name}: initialization and cleanup both failed: ${(error as Error).message}; ${(cleanupError as Error).message}`,
        );
      }
      throw error;
    }
  }

  private refreshTools(): Promise<void> {
    this.refreshAgain = true;
    this.refresh ??= (async () => {
      while (this.refreshAgain && !this.closing) {
        this.refreshAgain = false;
        try {
          const definitions = await this.client.listTools();
          if (this.closing) return;
          this.definitions = definitions;
          for (const listener of this.listeners) listener();
        } catch (error) {
          this.emit({
            kind: "log",
            server: this.server.name,
            line: `tools/list after list_changed failed: ${(error as Error).message}`,
          });
        }
      }
    })().finally(() => {
      this.refresh = undefined;
    });
    return this.refresh;
  }

  call(log: EventLog, name: string, args: unknown, signal: AbortSignal, timeoutMs: number) {
    return this.scope.run(log, () => this.client.callTool(name, args, { signal, timeoutMs }));
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.client.close();
      this.status.phase = "closed";
      delete this.status.error;
      this.requests.clear();
      this.active = undefined;
      this.listeners.clear();
    })().catch((error) => {
      this.status.phase = "failed";
      this.status.error = `cleanup failed: ${(error as Error).message}`;
      this.requests.clear();
      this.active = undefined;
      this.listeners.clear();
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}

/** 仅缓存仍被会话持有的连接;未激活的候选会话也持有引用,可以安全回滚。 */
export class McpConnections {
  private readonly entries = new Set<Connection>();
  private closed = false;
  async acquire(server: ResolvedServer, opts: ConnectionOptions, reconnect = false) {
    if (this.closed) throw new Error("MCP connections are closed");
    const {
      enabledTools: _enabled,
      disabledTools: _disabled,
      required: _required,
      ...identity
    } = server.config;
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
            )
          : value;
    const key = JSON.stringify(
      canonical({
        name: server.name,
        identity,
        protocolVersions: opts.mcp?.protocolVersions,
        maxResultChars: opts.mcp?.maxResultChars,
        clientVersion: opts.clientVersion,
      }),
    );
    // 归零对象仍由池持有以便重试清理,但不能再次借出。
    const existing =
      !reconnect &&
      [...this.entries].find(
        (c) => c.key === key && c.references > 0 && c.status.phase === "ready",
      );
    if (existing) {
      existing.references++;
      return { connection: existing, reused: true };
    }
    const connection = new Connection(key, server, opts);
    try {
      await connection.connect();
    } catch (error) {
      if (connection.status.phase !== "closed") this.entries.add(connection);
      throw error;
    }
    if (this.closed) {
      try {
        await connection.close();
      } catch (error) {
        this.entries.add(connection);
        throw new AggregateError(
          [new Error("MCP connections closed during preparation"), error],
          `MCP connections closed during preparation; cleanup failed: ${(error as Error).message}`,
        );
      }
      throw new Error("MCP connections closed during preparation");
    }
    connection.references = 1;
    this.entries.add(connection);
    return { connection, reused: false };
  }

  async release(connection: Connection): Promise<void> {
    connection.references--;
    if (connection.references > 0) return;
    await connection.close();
    this.entries.delete(connection);
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries];
    const results = await Promise.allSettled(entries.map((c) => c.close()));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") this.entries.delete(entries[index] as Connection);
    });
    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (errors.length) throw new AggregateError(errors, "MCP connection cleanup failed");
  }
}
