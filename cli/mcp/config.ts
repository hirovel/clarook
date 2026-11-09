// MCP 配置:config.json 的 mcp.servers,加上项目根 .mcp.json 的 mcpServers(与 Claude Code 同形,便于复用现成文件)。
// 同名以 config.json 为准且整条覆盖。${VAR} 与 ${VAR:-default} 展开;缺失的变量原样保留并报出来。
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
/** 一台 MCP 服务器。command 走 stdio,url 走 Streamable HTTP。 */
export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** 相对项目根。 */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 白名单先应用,黑名单后应用;通配 * ?。 */
  enabledTools?: string[];
  disabledTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** true = 连不上就启动失败;缺省 false,只记事件。 */
  required?: boolean;
  enabled?: boolean;
};

export type McpConfig = {
  servers?: Record<string, McpServerConfig>;
  /** 工具结果字符上限,缺省 100000。 */
  maxResultChars?: number;
  /** 愿意说的协议版本,优先级从前到后;缺省 2026-07-28 再 2025-06-18。 */
  protocolVersions?: string[];
};

/** 配置文件里的 mcp 键对内核是不透明对象;这里给它形状。 */
export function mcpConfigOf(raw: unknown): McpConfig | undefined {
  return raw && typeof raw === "object" ? (raw as McpConfig) : undefined;
}

/** 展开 ${VAR} / ${VAR:-default};缺失且无缺省值的原样保留。 */
export function expandVars(
  s: string,
  env: Record<string, string | undefined> = process.env,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (m, name: string, def?: string) => {
      const v = env[name];
      if (v !== undefined) return v;
      if (def !== undefined) return def;
      missing.push(name);
      return m;
    },
  );
  return { value, missing };
}

function expandRecord(
  r: Record<string, string>,
  env: Record<string, string | undefined>,
  missing: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    const e = expandVars(v, env);
    out[k] = e.value;
    missing.push(...e.missing);
  }
  return out;
}

export type ResolvedServer = {
  name: string;
  config: McpServerConfig;
  missing: string[];
  source: string;
};

export type ProjectMcpFile = {
  file: string;
  raw: string;
  servers: Record<string, McpServerConfig & { type?: string }>;
};

/** 一次读取项目配置;审核与连接共用这个快照,避免显示 A 却启动 B。 */
export function readProjectMcpFile(cwd: string): ProjectMcpFile | undefined {
  const file = join(cwd, ".mcp.json");
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: ProjectMcpFile["servers"] };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("expected a JSON object");
    const servers = parsed.mcpServers ?? {};
    if (typeof servers !== "object" || Array.isArray(servers))
      throw new Error("mcpServers must be an object");
    for (const [name, config] of Object.entries(servers))
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error(`mcpServers.${name} must be an object`);
    return { file, raw, servers };
  } catch (error) {
    throw new Error(`failed to parse ${file}: ${(error as Error).message}`);
  }
}

/** 合并两处来源并展开变量。 */
export function loadMcpServers(
  mcp: McpConfig | undefined,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  project: ProjectMcpFile | null = readProjectMcpFile(cwd) ?? null,
): ResolvedServer[] {
  const merged = new Map<string, { config: McpServerConfig; source: string }>();
  if (project) {
    for (const [name, c] of Object.entries(project.servers)) {
      const { type, ...rest } = c;
      void type;
      merged.set(name, { config: rest, source: project.file });
    }
  }
  for (const [name, c] of Object.entries(mcp?.servers ?? {}))
    merged.set(name, { config: c, source: "config.json" });
  const out: ResolvedServer[] = [];
  for (const [name, { config, source }] of merged) {
    if (config.enabled === false) continue;
    const missing: string[] = [];
    const resolved: McpServerConfig = { ...config };
    if (config.args)
      resolved.args = config.args.map((a) => {
        const e = expandVars(a, env);
        missing.push(...e.missing);
        return e.value;
      });
    if (config.env) resolved.env = expandRecord(config.env, env, missing);
    if (config.headers) resolved.headers = expandRecord(config.headers, env, missing);
    if (config.url) {
      const e = expandVars(config.url, env);
      resolved.url = e.value;
      missing.push(...e.missing);
    }
    if (config.command || config.cwd) resolved.cwd = resolve(cwd, config.cwd ?? ".");
    out.push({ name, config: resolved, missing: [...new Set(missing)], source });
  }
  return out;
}
