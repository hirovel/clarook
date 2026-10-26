import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CompactionStrategy,
  clearToolResults,
  llmSummarize,
  pipeline,
} from "../src/compaction.js";
import { DEFAULT_COMPACTION_SETTINGS, summaryPrompt } from "../src/compaction-presets.js";
import type { Preset } from "../src/config.js";
import type { CompactionConfig } from "../src/loop.js";
import { parsePreservation } from "./args.js";

/** 自动压缩阈值之下预留给回复与工具结果的 token 数。 */
export const RESERVE = DEFAULT_COMPACTION_SETTINGS.compactionReserve;

type SummaryOptions = NonNullable<Parameters<typeof llmSummarize>[0]>;
export const BUILTIN_STRATEGIES: Record<string, (options?: SummaryOptions) => CompactionStrategy> =
  {
    llm: (options) => llmSummarize(options),
    clear: () => clearToolResults(),
    pipeline: (options) => pipeline(clearToolResults(), llmSummarize(options)),
  };

/** 保存配置只验证名称语法,不能为检查模块路径提前执行用户脚本。 */
export function validateCompactionName(name: string): void {
  if (Object.hasOwn(BUILTIN_STRATEGIES, name) || /[\\/]|\.(m?js|ts)$/.test(name)) return;
  throw new Error(
    `unknown compaction strategy "${name}"; choices: ${Object.keys(BUILTIN_STRATEGIES).join(" ")}, or a module path`,
  );
}

export type CompactionSettings = Pick<
  Preset,
  | "compaction"
  | "compactionReserve"
  | "compactionRatio"
  | "compactionTrigger"
  | "compactionPrompt"
  | "compactionMaxTokens"
  | "compactionAcceptance"
  | "preservation"
>;

/** 模板正文只有一个加载入口；设置预览与运行策略用同一份文本。 */
export async function loadSummaryPrompt(value: string): Promise<string> {
  const builtin = summaryPrompt(value);
  if (builtin !== undefined) return builtin;
  if (!/\.md$/i.test(value))
    throw new Error(
      `Unknown summary template "${value}"; choose a built-in template or a .md file.`,
    );
  const prompt = await readFile(resolve(value), "utf8");
  if (!prompt.trim()) throw new Error(`Summary template ${value} is empty.`);
  return prompt;
}

/**
 * 压缩策略:内置名,或外部模块路径(扩展点)。模块用 default 导出一个 CompactionStrategy 函数,
 * 例如 `export default async (input) => ({ cleared: [...], strategy: "我的策略" })`。
 * 这样对比新策略不必改仓库代码:`pnpm once -- "任务" --compaction ./my-strategy.mjs --json`。
 */
export async function loadCompactionStrategy(
  name: string,
  options?: SummaryOptions,
): Promise<CompactionStrategy> {
  validateCompactionName(name);
  const builtin = Object.hasOwn(BUILTIN_STRATEGIES, name) && BUILTIN_STRATEGIES[name];
  if (builtin) return builtin(options);
  const mod = (await import(pathToFileURL(resolve(name)).href)) as {
    default?: unknown;
    strategy?: unknown;
  };
  const fn = mod.default ?? mod.strategy;
  if (typeof fn !== "function") {
    throw new Error(`compaction strategy module ${name} must default-export a function`);
  }
  return fn as CompactionStrategy;
}

export async function buildCompaction(
  values: CompactionSettings,
  window: number,
): Promise<CompactionConfig> {
  const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...values };
  const summaryOptions =
    settings.compaction === "llm" || settings.compaction === "pipeline"
      ? {
          prompt: await loadSummaryPrompt(settings.compactionPrompt),
          maxTokens: settings.compactionMaxTokens,
          acceptance: settings.compactionAcceptance,
        }
      : undefined;
  return {
    strategy: await loadCompactionStrategy(settings.compaction, summaryOptions),
    window,
    reserveTokens: settings.compactionReserve,
    ratio: settings.compactionRatio,
    trigger: settings.compactionTrigger,
    acceptance: settings.compactionAcceptance,
    preservation: parsePreservation(
      settings.preservation ?? DEFAULT_COMPACTION_SETTINGS.preservation,
      window,
    ).policy,
  };
}
