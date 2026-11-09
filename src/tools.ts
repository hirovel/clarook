import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import { ValueErrorType } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import type { ToolOutput } from "./exchange.js";

/**
 * 可执行工具:ToolDef(wire 层纯描述)加 execute。
 * 契约:返回纯文本;失败一律 throw,由循环捕获转成 tool/result{isError:true}。
 * ctx.signal 必须被长任务工具响应,否则即时打断到不了子进程。
 */
export type ToolContext = {
  signal: AbortSignal;
  /** 本次调用在模型响应里的 id;工具据此把自己派生的东西(如子 agent 会话)关联回调用行。 */
  callId?: string;
  /** 在截断、转义、格式转换之前写入实际输出;不改变工具的读取与执行范围。 */
  output?: ToolOutput;
};

/** 本地等待结束不等于外部执行失败。适配器仅在缺少结果证据时抛出。 */
export class ToolOutcomeUnknownError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(
      `Execution outcome unknown: ${reason}\nThe tool may have produced side effects or may still be running. No automatic retry was performed. Check the actual state before deciding whether to retry or continue, using the existing tool permissions.`,
      options,
    );
  }
}

/**
 * 描述的分段:core 说做什么、参数含义与硬限制;guidance 说什么时候该换别的工具、失败原因、省 token 的用法;
 * rules 是 ALWAYS / NEVER 的工具选择禁令;suffix 任何档都附在末尾(如 task 的类型与范围列表)。
 * 一份来源,风格槽只决定拼到第几段;内核只发 description 字符串。
 */
export type DescriptionParts = { core: string; guidance?: string; rules?: string; suffix?: string };

/** 拼接层级:brief 只有 core;explain 加 guidance;rules 三段都要。 */
export type DescriptionLevel = "brief" | "explain" | "rules";
export const DESCRIPTION_LEVELS: DescriptionLevel[] = ["brief", "explain", "rules"];

export function composeDescription(parts: DescriptionParts, level: DescriptionLevel): string {
  const body = [
    parts.core,
    level !== "brief" ? parts.guidance : undefined,
    level === "rules" ? parts.rules : undefined,
  ]
    .filter((p): p is string => Boolean(p))
    .join(" ");
  return parts.suffix ? `${body}\n\n${parts.suffix}` : body;
}

/** 工具文件里用:给出分段,同时得到缺省档(explain)的 description。 */
export function described(parts: DescriptionParts): {
  describe: DescriptionParts;
  description: string;
} {
  return { describe: parts, description: composeDescription(parts, "explain") };
}

export type Tool<S extends TSchema = TSchema> = {
  name: string;
  description: string;
  /** 分段的描述;给了它,风格槽按层拼接,description 只是缺省档(explain)的拼接结果。 */
  describe?: DescriptionParts;
  /** TypeBox schema,本身就是 JSON Schema 对象,原样进 wire 请求。 */
  parameters: S;
  execute(args: Static<S>, ctx: ToolContext): Promise<string>;
  /**
   * 并行安全声明:parallel = 与同批其它并行安全的调用可同时跑(只读工具);
   * 缺省 sequential = 必须独占(写文件、跑命令)。只在执行槽选了并行策略时有意义。
   */
  concurrency?: "parallel" | "sequential";
};

/** 定义处获得 Static<S> 的参数类型推导;运行期原样返回。 */
export function defineTool<S extends TSchema>(tool: Tool<S>): Tool<S> {
  return tool;
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * 参数校验(循环在执行前统一调用):
 * Value.Convert 先做类型强转(模型爱把数字发成字符串),再 Check。
 * 错误文本仿 pi:逐路径列错误,末尾附收到的参数原文,让模型看见自己发了什么。
 */
export function validateArgs(schema: TSchema, raw: unknown): ValidationResult {
  if (typeof raw === "object" && raw !== null && "__unparsed" in raw) {
    return {
      ok: false,
      error: `Tool arguments are not valid JSON. Received text:\n${String((raw as { __unparsed: unknown }).__unparsed)}`,
    };
  }
  // 外来的 JSON Schema(MCP 服务器给的,没有 TypeBox 的 Kind 标记)不在这里校验:服务器自己校验,协议错误会回来。
  if (!(Kind in schema)) return { ok: true, value: raw };
  // 数组是调用结构,不能把误传的单对象包成数组;标量仍沿用已有转换。
  const rawErrors = [...Value.Errors(schema, raw)];
  const arrayMismatch = rawErrors.some((error) => error.type === ValueErrorType.Array);
  // Clone:raw 已作为事件入日志,Convert 不许碰历史。
  const converted = arrayMismatch ? raw : Value.Convert(schema, Value.Clone(raw));
  if (Value.Check(schema, converted)) return { ok: true, value: converted };

  const lines = (arrayMismatch ? rawErrors : [...Value.Errors(schema, converted)]).map(
    (e) => `  - ${e.path || "/"}: ${e.message}`,
  );
  return {
    ok: false,
    error: `Tool argument validation failed:\n${lines.join("\n")}\nReceived arguments:\n${JSON.stringify(raw, null, 2)}`,
  };
}
