// 审批策略:每个工具调用执行前,先由规则给出 allow / ask / deny 三种裁决;ask 才轮到人。
// 规则是纯数据(配置或会话中 /approve 加的),裁决是纯函数,理由随裁决一起给出,界面照抄,不另起解释。
// 内核不认识"危险命令":它只按规则匹配。哪些命令危险是用户的知识,写进 deny 规则。
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall } from "./events.js";
import type { ApproveOrigin, ApprovePolicy } from "./loop.js";

export type ApprovalConfig = {
  /** 没有规则命中时:ask(缺省)= 问人;allow = 放行。 */
  default?: "allow" | "ask";
  /** 放行规则:`工具名` 或 `工具名:模式`。模式对 bash 匹配整条命令,对路径类工具匹配相对 cwd 的路径。 */
  allow?: string[];
  /** 拒绝规则,优先于一切:命中即以"策略拒绝"回喂模型,不问人。 */
  deny?: string[];
  /** 路径类工具指向 cwd 之外时:ask(缺省)= 就算 allow 规则命中也问;allow = 照规则;deny = 直接拒。 */
  outsideCwd?: "ask" | "allow" | "deny";
};

/** 内置缺省:只读工具放行,其余问人,cwd 之外必问。 */
export const DEFAULT_APPROVAL: ApprovalConfig = {
  default: "ask",
  allow: ["read", "grep", "glob", "skill", "task", "remember"],
  deny: [],
  outsideCwd: "ask",
};

export type Verdict = { verdict: "allow" | "ask" | "deny"; reason: string };

/** 审批的返回:true / false 保持兼容;对象形态可带理由,理由原样进工具结果。 */
export type ApproveDecision = boolean | { allowed: boolean; reason?: string };

/** 路径类工具的路径参数名。 */
const PATH_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

/** 规则模式匹配的对象:bash 是整条命令;路径类工具是路径;其它工具没有模式,只按名匹配。 */
export function subjectOf(call: ToolCall): string | undefined {
  const a = (call.args ?? {}) as Record<string, unknown>;
  if (call.name === "bash") return typeof a.command === "string" ? a.command : undefined;
  if (call.name === "fetch") return typeof a.url === "string" ? a.url : undefined;
  // 带命名空间的工具:prefix__group__name → "group:name",规则写 prefix:group:name*,如 mcp:github:get_*。
  const ns = namespaceOf(call.name);
  if (ns) {
    const rest = call.name.slice(ns.length + 2);
    const i = rest.indexOf("__");
    return i < 0 ? rest : `${rest.slice(0, i)}:${rest.slice(i + 2)}`;
  }
  if (PATH_TOOLS.has(call.name)) return typeof a.path === "string" ? a.path : ".";
  return undefined;
}

/** 工具名的命名空间:双下划线之前的第一段(mcp__github__get_issue → mcp);没有双下划线就没有。 */
function namespaceOf(toolName: string): string | undefined {
  const i = toolName.indexOf("__");
  return i > 0 ? toolName.slice(0, i) : undefined;
}

/** 通配符 → 正则:`*` 任意长度(含空格与斜杠),`?` 单字符。命令与路径共用,路径不做分段语义,够用且好解释。 */
function wildcard(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (/[.+^${}()|[\]\\/]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`, "s");
}

export function ruleMatches(rule: string, call: ToolCall, cwd: string): boolean {
  const i = rule.indexOf(":");
  const name = i < 0 ? rule : rule.slice(0, i);
  const byNamespace = namespaceOf(call.name) === name;
  if (name !== call.name && name !== "*" && !byNamespace) return false;
  if (i < 0) return true;
  const pattern = rule.slice(i + 1);
  const subject = subjectOf(call);
  if (subject === undefined) return false;
  const matches = wildcard(pattern);
  // 只授权实际解析后的目标;原始 src/../x 不能借 src/** 的文字前缀获准。
  if (PATH_TOOLS.has(call.name)) {
    const abs = resolve(cwd, subject);
    const rel = relative(cwd, abs) || ".";
    return matches.test(rel.split(sep).join("/")) || matches.test(abs.split(sep).join("/"));
  }
  return matches.test(subject);
}

/** 路径类工具的目标是否落在 cwd 之外。 */
export function outsideCwd(call: ToolCall, cwd: string): boolean {
  if (!PATH_TOOLS.has(call.name)) return false;
  const subject = subjectOf(call);
  if (subject === undefined) return false;
  const abs = resolve(cwd, subject);
  const rel = relative(cwd, abs);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** 裁决顺序:deny 规则 → cwd 之外 → allow 规则 → 缺省。理由说的是命中了哪条。 */
export function decide(call: ToolCall, cfg: ApprovalConfig, cwd: string): Verdict {
  for (const r of cfg.deny ?? []) {
    if (ruleMatches(r, call, cwd)) return { verdict: "deny", reason: `deny rule ${r}` };
  }
  if (outsideCwd(call, cwd)) {
    const mode = cfg.outsideCwd ?? "ask";
    if (mode === "deny") return { verdict: "deny", reason: "path outside the working directory" };
    if (mode === "ask") return { verdict: "ask", reason: "path outside the working directory" };
  }
  for (const r of cfg.allow ?? []) {
    if (ruleMatches(r, call, cwd)) return { verdict: "allow", reason: `allow rule ${r}` };
  }
  return cfg.default === "allow"
    ? { verdict: "allow", reason: "default allow" }
    : { verdict: "ask", reason: `no rule for ${call.name}` };
}

/** 一行说清当前策略,给 /approve 与 /slots 用。 */
export function describeApproval(cfg: ApprovalConfig): string {
  const parts = [
    `default ${cfg.default ?? "ask"}`,
    `allow [${(cfg.allow ?? []).join(", ")}]`,
    ...((cfg.deny ?? []).length > 0 ? [`deny [${(cfg.deny ?? []).join(", ")}]`] : []),
    `outside cwd ${cfg.outsideCwd ?? "ask"}`,
  ];
  return parts.join(" · ");
}

/**
 * 把策略装成审批槽:allow 直接过,deny 直接拒(带理由),ask 交给 asker。
 * 没有人可问的场合(一次性模式)传 asker = undefined,ask 一律按拒绝处理,理由说明原因。
 */
export function policyApprove(
  cfg: ApprovalConfig,
  asker:
    | ((
        call: ToolCall,
        why: string,
        origin?: ApproveOrigin,
        signal?: AbortSignal,
      ) => Promise<ApproveDecision>)
    | undefined,
  cwd = process.cwd(),
): ApprovePolicy {
  return async (call, origin, signal) => {
    const v = decide(call, cfg, cwd);
    if (v.verdict === "allow") return true;
    if (v.verdict === "deny") return { allowed: false, reason: `approval policy: ${v.reason}` };
    if (!asker) {
      return {
        allowed: false,
        reason: `approval policy: ${v.reason}; no one to ask in one-shot mode, add an allow rule or run with --approve all`,
      };
    }
    return asker(call, v.reason, origin, signal);
  };
}
