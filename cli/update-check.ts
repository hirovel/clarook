// 更新检查属于界面启动,不进入模型上下文或会话事实。
import { readFileSync } from "node:fs";
import { gt, prerelease, valid } from "semver";

const VERSION_URL = "https://registry.npmjs.org/clarook/latest";
export const UPDATE_COMMAND = "npm install -g clarook@latest";

export function installedVersion(): string | undefined {
  // 源码运行与 dist/cli 安装运行分别读取同一份包元数据。
  for (const path of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
      if (pkg.name === "clarook" && typeof pkg.version === "string")
        return valid(pkg.version) ?? undefined;
    } catch {
      // 更新提示不可阻止缺少元数据的开发环境启动。
    }
  }
  return undefined;
}

export async function checkForUpdate(
  options: {
    currentVersion?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ current: string; latest: string } | undefined> {
  const current = valid(options.currentVersion ?? installedVersion() ?? "");
  if (!current || options.signal?.aborted) return undefined;
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 3000);
    const response = await (options.fetchImpl ?? fetch)(VERSION_URL, {
      headers: { Accept: "application/json", "User-Agent": `clarook/${current}` },
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return undefined;
    const release = data as { version?: unknown };
    if (typeof release.version !== "string") return undefined;
    const latest = valid(release.version);
    if (latest && !prerelease(latest) && gt(latest, current) && !options.signal?.aborted)
      return { current, latest };
  } catch {
    // 离线、超时或格式错误仅意味着本次没有可确认的更新提示。
  }
  return undefined;
}
