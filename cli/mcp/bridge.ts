// MCP 工具桥接:每个 MCP 工具映射成内核的 Tool,名字 mcp__<server>__<tool>;
// 服务器的启动、失败、每次往返、stderr、工具表变化都记成 ext/event(source "mcp")。内核不知道 MCP 的存在。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { type AgentEvent, now } from "../../src/events.js";
import type { EventLog } from "../../src/log.js";
import type { ContentRef } from "../../src/recording.js";
import { type Tool, ToolOutcomeUnknownError } from "../../src/tools.js";
import {
  type McpClient,
  type McpClient as McpClientType,
  type McpContent,
  McpOutcomeUnknownError,
} from "./client.js";
import type { McpConfig, ResolvedServer } from "./config.js";
import { type Connection, McpConnections } from "./connections.js";

export type McpServerStatus = {
  name: string;
  phase: "ready" | "failed" | "closed";
  transport: "stdio" | "http";
  era?: "modern" | "legacy";
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  toolCount: number;
  error?: string;
  ms: number;
  missingVars: string[];
  connection?: "new" | "reused" | "reconnected";
};

export type McpBridge = {
  statuses(): McpServerStatus[];
  /** 全部工具名(桥接后的)。 */
  toolNames(): string[];
  activate(): void;
  close(): Promise<void>;
};

/** 桥接记的四种事件,装在 ext/event 的 payload 里;kind 是判别字段。 */
export type McpEvent =
  | { kind: "project-trusted" | "project-skipped"; file: string }
  | {
      kind: "server";
      server: string;
      phase: "starting" | "ready" | "failed" | "closed";
      transport: "stdio" | "http";
      era?: "modern" | "legacy";
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      toolCount?: number;
      /** 服务器列出的工具数(过滤前)。 */
      listed?: number;
      instructions?: string;
      error?: string;
      warning?: string;
      ms?: number;
      connection?: McpServerStatus["connection"];
    }
  | {
      kind: "rpc";
      server: string;
      direction: "send" | "receive";
      method?: string;
      id?: number | string;
      bytes: number;
      /** 原文,Authorization 已遮蔽。 */
      body: string;
      truncated?: boolean;
      bodyRef?: ContentRef;
    }
  | { kind: "log"; server: string; line: string }
  | { kind: "tools"; server: string; added: string[]; removed: string[]; total: number };

function emit(log: EventLog, ev: McpEvent): void {
  const { kind, ...payload } = ev;
  log.append({ type: "ext/event", at: now(), source: "mcp", kind, payload });
}

/** 从日志事件读回桥接事件;不是 MCP 的返回 undefined。 */
export function mcpEvent(e: AgentEvent): McpEvent | undefined {
  if (e.type !== "ext/event" || e.source !== "mcp") return undefined;
  return { kind: e.kind, ...e.payload } as McpEvent;
}

/** 主屏与检视器的一行;rpc 与 log 不上屏(检视器的事件视图有全文)。 */
export function renderMcpEvent(
  e: AgentEvent,
): { tone: "jin" | "zhu" | "faint"; text: string } | undefined {
  const m = mcpEvent(e);
  if (!m) return undefined;
  if (m.kind === "project-trusted" || m.kind === "project-skipped")
    return {
      tone: m.kind === "project-trusted" ? "jin" : "zhu",
      text: `◇ project MCP ${m.kind === "project-trusted" ? "trusted" : "skipped"}: ${m.file}`,
    };
  if (m.kind === "server") {
    if (m.phase === "ready")
      return {
        tone: "jin",
        text: `◇ mcp ${m.server}: ready · ${m.transport} · ${m.era ?? ""} ${m.protocolVersion ?? ""} · ${m.toolCount ?? 0} tools${m.listed !== undefined && m.listed !== m.toolCount ? ` of ${m.listed} listed` : ""} · ${m.ms ?? 0}ms`,
      };
    if (m.phase === "failed" || m.phase === "closed")
      return {
        tone: "zhu",
        text: `◇ mcp ${m.server}: ${m.phase}${m.error ? ` · ${m.error}` : ""}`,
      };
    if (m.warning) return { tone: "faint", text: `· mcp ${m.server}: ${m.warning}` };
    return undefined;
  }
  if (m.kind === "tools") {
    if (m.added.length + m.removed.length === 0 || m.total === m.added.length) return undefined;
    return {
      tone: "jin",
      text: `◇ mcp ${m.server}: tools changed · +${m.added.length} −${m.removed.length} · ${m.total} total · applies from the next request`,
    };
  }
  return undefined;
}

const MAX_NAME = 128;

export function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 无损短名保持可读;清洗、分隔或截断会混淆身份时,用原始二元组稳定消歧。 */
export function bridgedName(server: string, tool: string): string {
  const safeServer = sanitizeName(server);
  const safeTool = sanitizeName(tool);
  const full = `mcp__${safeServer}__${safeTool}`;
  if (
    full.length <= MAX_NAME &&
    safeServer === server &&
    safeTool === tool &&
    !server.includes("__") &&
    !server.endsWith("_")
  )
    return full;
  const hash = createHash("sha1")
    .update(JSON.stringify([server, tool]))
    .digest("hex")
    .slice(0, 12);
  return `${full.slice(0, MAX_NAME - 13)}_${hash}`;
}

function wildcard(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
}

export function toolAllowed(name: string, enabled?: string[], disabled?: string[]): boolean {
  if (enabled && enabled.length > 0 && !enabled.some((p) => wildcard(p).test(name))) return false;
  if (disabled?.some((p) => wildcard(p).test(name))) return false;
  return true;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

/** 工具结果 content[] → 文本。二进制块落盘(有目录时),文本里留一行路径。 */
export function contentToText(
  content: McpContent[],
  opts: { dir?: string; callId?: string } = {},
): string {
  const parts: string[] = [];
  content.forEach((c, i) => {
    if (c.type === "text") parts.push((c as { text: string }).text);
    else if (c.type === "image" || c.type === "audio") {
      const b = c as { data: string; mimeType: string };
      const bytes = Buffer.from(b.data, "base64");
      if (opts.dir) {
        mkdirSync(opts.dir, { recursive: true });
        const file = join(opts.dir, `${opts.callId ?? "result"}-${i}.${EXT[b.mimeType] ?? "bin"}`);
        writeFileSync(file, bytes);
        parts.push(`[${c.type} ${b.mimeType}, ${bytes.length} bytes, saved to ${file}]`);
      } else parts.push(`[${c.type} ${b.mimeType}, ${bytes.length} bytes, not saved]`);
    } else if (c.type === "resource") {
      const r = (c as { resource: { uri: string; text?: string; mimeType?: string } }).resource;
      parts.push(
        r.text !== undefined
          ? `[resource ${r.uri}]\n${r.text}`
          : `[resource ${r.uri}${r.mimeType ? ` ${r.mimeType}` : ""}, binary not inlined]`,
      );
    } else if (c.type === "resource_link") {
      const l = c as { uri: string; name?: string };
      parts.push(`[resource link ${l.name ? `${l.name} ` : ""}${l.uri}]`);
    } else parts.push(`[${c.type} content, not rendered]`);
  });
  return parts.join("\n");
}

export type ConnectOptions = {
  log: EventLog;
  artifactsDir?: string;
  tools: Tool[];
  mcp?: McpConfig;
  clientVersion?: string;
  createClient?: (
    server: ResolvedServer,
    opts: ConstructorParameters<typeof McpClient>[2],
  ) => McpClientType;
  connections?: McpConnections;
  reconnect?: string[];
  /** 候选会话先准备资源,成功后才切换连接事件的归属。 */
  activate?: boolean;
};

export async function connectMcpServers(
  servers: ResolvedServer[],
  opts: ConnectOptions,
): Promise<McpBridge> {
  const pool = opts.connections ?? new McpConnections();
  const bindings: {
    connection: Connection;
    server: ResolvedServer;
    status: McpServerStatus;
    install: () => void;
  }[] = [];
  const failed: McpServerStatus[] = [];
  const names = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      closed = true;
      for (let i = opts.tools.length - 1; i >= 0; i--)
        if (names.has(opts.tools[i]?.name ?? "")) opts.tools.splice(i, 1);
      const results = await Promise.allSettled(
        bindings.map(async ({ connection, install, status }) => {
          connection.listeners.delete(install);
          if (connection.active === opts.log) connection.active = undefined;
          try {
            await pool.release(connection);
            status.phase = "closed";
          } catch (error) {
            status.phase = "failed";
            status.error = `cleanup failed: ${(error as Error).message}`;
            throw error;
          }
        }),
      );
      const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (errors.length) throw new AggregateError(errors, "MCP session cleanup failed");
    })());
  try {
    for (const server of servers) {
      const started = Date.now();
      let acquired: Awaited<ReturnType<McpConnections["acquire"]>>;
      try {
        acquired = await pool.acquire(server, opts, opts.reconnect?.includes(server.name));
      } catch (error) {
        if (server.config.required)
          throw new Error(
            `mcp server ${server.name} is required but failed: ${(error as Error).message}`,
          );
        failed.push({
          name: server.name,
          phase: "failed",
          transport: server.config.url ? "http" : "stdio",
          toolCount: 0,
          ms: Date.now() - started,
          missingVars: server.missing,
          error: (error as Error).message,
        });
        continue;
      }
      const { connection, reused } = acquired;
      const status: McpServerStatus = {
        ...connection.status,
        connection: reused
          ? "reused"
          : opts.reconnect?.includes(server.name)
            ? "reconnected"
            : "new",
      };
      let installed: string[] = [];
      const install = () => {
        if (closed) return;
        const before = installed;
        const definitions = connection.definitions.filter((d) =>
          toolAllowed(d.name, server.config.enabledTools, server.config.disabledTools),
        );
        const occupied = new Set(
          opts.tools.filter((tool) => !before.includes(tool.name)).map((tool) => tool.name),
        );
        const fresh: Tool[] = definitions.map((definition) => {
          const name = bridgedName(server.name, definition.name);
          if (occupied.has(name))
            throw new Error(`mcp ${server.name}: duplicate tool name ${name} (${definition.name})`);
          occupied.add(name);
          return {
            name,
            description: definition.description ?? definition.title ?? "",
            parameters: (definition.inputSchema ?? { type: "object" }) as unknown as TSchema,
            concurrency: "sequential",
            async execute(args, ctx) {
              if (closed) throw new Error("This MCP session is closed");
              const result = await connection
                .call(
                  opts.log,
                  definition.name,
                  args,
                  ctx.signal,
                  server.config.toolTimeoutMs ?? 60000,
                )
                .catch((error: unknown) => {
                  if (error instanceof McpOutcomeUnknownError)
                    throw new ToolOutcomeUnknownError(error.message, { cause: error });
                  throw error;
                });
              ctx.output?.write(JSON.stringify(result));
              let text = contentToText(result.content, {
                ...(opts.artifactsDir && { dir: opts.artifactsDir }),
                ...(ctx.callId && { callId: ctx.callId }),
              });
              if (result.structuredContent !== undefined && !text.trim())
                text = JSON.stringify(result.structuredContent, null, 2);
              const max = opts.mcp?.maxResultChars ?? 100000;
              if (text.length > max) {
                const length = text.length;
                const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
                const original = ctx.output?.path;
                const location =
                  ctx.output?.ref.missingFrom !== undefined
                    ? `; raw recording incomplete from byte ${ctx.output.ref.missingFrom}; available prefix: ${original}`
                    : original
                      ? `; full raw MCP result: ${original}`
                      : "";
                text = `${text.slice(0, end)}\n[truncated to ${end} chars of ${length}${location}]`;
              }
              if (result.isError)
                throw new Error(text || "tool reported an error without a message");
              return text;
            },
          };
        });
        for (let i = opts.tools.length - 1; i >= 0; i--)
          if (before.includes(opts.tools[i]?.name ?? "")) opts.tools.splice(i, 1);
        for (const name of before) names.delete(name);
        opts.tools.push(...fresh);
        installed = fresh.map((t) => t.name);
        for (const name of installed) names.add(name);
        status.phase = connection.status.phase;
        status.toolCount = fresh.length;
        const added = installed.filter((name) => !before.includes(name));
        const removed = before.filter((name) => !installed.includes(name));
        if (added.length || removed.length)
          emit(opts.log, {
            kind: "tools",
            server: server.name,
            added,
            removed,
            total: installed.length,
          });
      };
      bindings.push({ connection, server, status, install });
      connection.listeners.add(install);
      install();
      emit(opts.log, {
        kind: "server",
        server: server.name,
        phase: "ready",
        transport: status.transport,
        ...(status.era && { era: status.era }),
        ...(status.protocolVersion && { protocolVersion: status.protocolVersion }),
        ...(status.serverInfo && { serverInfo: status.serverInfo }),
        ...(status.instructions && { instructions: status.instructions }),
        toolCount: status.toolCount,
        listed: connection.definitions.length,
        ms: status.ms,
        connection: status.connection,
      });
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `MCP initialization failed: ${(error as Error).message}`,
      );
    }
    throw error;
  }
  const activate = () => {
    if (closed) throw new Error("This MCP session is closed");
    for (const { connection } of bindings) connection.active = opts.log;
  };
  if (opts.activate !== false) activate();
  return {
    statuses: () => [
      ...bindings.map(({ connection, status }) => ({
        ...status,
        ...(status.phase !== "closed" && { phase: connection.status.phase }),
        ...(connection.status.error && { error: connection.status.error }),
      })),
      ...failed,
    ],
    toolNames: () => [...names],
    activate,
    close,
  };
}

/** 一行状态,/mcp 与 /slots 用。 */
export function describeStatus(s: McpServerStatus): string {
  const head = `${s.name.padEnd(12)} ${s.phase.padEnd(7)}`;
  if (s.phase === "failed") return `${head} ${s.error ?? "unknown error"} (${s.ms}ms)`;
  const info = [
    s.transport,
    s.era ?? "",
    s.protocolVersion ?? "",
    s.connection ?? "",
    `${s.toolCount} tools`,
    `${s.ms}ms`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${head} ${info}${s.error ? ` · ${s.error}` : ""}${s.missingVars.length > 0 ? ` · unset: ${s.missingVars.join(", ")}` : ""}`;
}
