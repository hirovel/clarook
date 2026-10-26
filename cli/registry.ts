// 模型登记簿:models.dev 的公开清单(opencode 与 pi 都用它)是能力数据的缺省来源,配置只写覆盖。
// 顺序:模型对象里明写的 > models.dev(内置快照 + 每天刷新的缓存)> 供应商级配置 > 假设;每一级都有出处,上屏可见。
// 服务器上有、配置里没有的模型:models.dev 命中就只把名字写进配置(数据保持活的);
// 没命中抄最像的已配置模型(最长公共前缀)写进去;再不行只写名字,运行时按假设值并标红。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clarookHome,
  type ModelConfig,
  type ModelPrice,
  modelConfig,
  type ProviderConfig,
} from "../src/config.js";
import type { EffortLevel } from "../src/provider.js";
import { SNAPSHOT, SNAPSHOT_DATE } from "./models.snapshot.js";

export const REGISTRY_URL = "https://models.dev/api.json";
/** 缓存有效期:一天。过期后后台重取,取不到就继续用旧的。 */
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

export type RegistryModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: { type: string; values?: string[]; [k: string]: unknown }[];
  tool_call?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  /** 每百万 token 的美元。 */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

export type Registry = Record<
  string,
  { id?: string; api?: string; env?: string[]; models?: Record<string, RegistryModel> }
>;

export function registryCachePath(env = process.env): string {
  return join(clarookHome(env), "models.dev.json");
}

/**
 * 取登记簿:缓存新鲜就直接用;否则联网取并写缓存;联网失败退回旧缓存;都没有返回 undefined。
 * 4 秒超时,不阻塞登录对话框太久。
 */
export async function fetchRegistry(
  opts: { cachePath?: string; ttlMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Registry | undefined> {
  const path = opts.cachePath ?? registryCachePath();
  const ttl = opts.ttlMs ?? REGISTRY_TTL_MS;
  const cached = readCache(path);
  if (cached && Date.now() - cached.mtime < ttl) return cached.data;
  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(REGISTRY_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 4000) });
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const data = (await res.json()) as Registry;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
    return data;
  } catch {
    return cached?.data;
  }
}

/** 同步取登记簿:缓存文件能读就用它(新旧不论),否则内置快照。启动时用,不等网络。 */
export function loadRegistrySync(cachePath = registryCachePath()): Registry {
  return readCache(cachePath)?.data ?? SNAPSHOT;
}

export { SNAPSHOT, SNAPSHOT_DATE };

function readCache(path: string): { data: Registry; mtime: number } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return {
      data: JSON.parse(readFileSync(path, "utf8")) as Registry,
      mtime: statSync(path).mtimeMs,
    };
  } catch {
    return undefined;
  }
}

/** 我们的供应商名是用户起的;按 baseUrl 的主机认 models.dev 里的 id,认不出就按名字。 */
export function registryProviderId(
  providerName: string,
  p: Pick<ProviderConfig, "baseUrl">,
): string {
  const host = (() => {
    try {
      return new URL(p.baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  if (/deepseek\.com$/.test(host)) return "deepseek";
  if (/openai\.com$/.test(host)) return "openai";
  if (/anthropic\.com$/.test(host)) return "anthropic";
  if (/openrouter\.ai$/.test(host)) return "openrouter";
  return providerName;
}

/** 在登记簿里找一个模型:先按供应商 id,再全库按模型 id 扫。 */
export function lookupModel(
  registry: Registry,
  providerId: string,
  modelId: string,
): RegistryModel | undefined {
  const direct = registry[providerId]?.models?.[modelId];
  if (direct) return direct;
  for (const p of Object.values(registry)) {
    const m = p.models?.[modelId];
    if (m) return m;
  }
  return undefined;
}

const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/** 登记簿条目 → 配置里的模型对象。价格单位一致(每百万 token,美元)。 */
export function modelConfigFromRegistry(modelId: string, m: RegistryModel): ModelConfig {
  const effort = m.reasoning_options
    ?.find((o) => o.type === "effort")
    ?.values?.filter((v): v is EffortLevel => EFFORTS.has(v));
  // 开关与档位是两项能力;仅有开关时不猜测可用档位。
  if (effort?.length && m.reasoning_options?.some((o) => o.type === "toggle")) {
    effort.unshift("off");
  }
  return {
    name: modelId,
    ...(m.limit?.context && { contextWindow: m.limit.context }),
    ...(m.limit?.output && { maxTokens: m.limit.output }),
    ...(effort && effort.length > 0 && { effortLevels: effort }),
    ...(m.cost?.input !== undefined &&
      m.cost.output !== undefined && {
        price: {
          input: m.cost.input,
          output: m.cost.output,
          ...(m.cost.cache_read !== undefined && { cacheRead: m.cost.cache_read }),
        },
      }),
  };
}

/** 假设值:没有任何依据时的保守窗口。宁可早压缩,不要撞 400。 */
export const ASSUMED_CONTEXT = 65536;

export type CapabilitySource = "config" | "models.dev" | "assumed";

/** 一个模型生效的能力数据与每项的出处。 */
export type Capabilities = {
  contextWindow: number;
  maxTokens?: number;
  effortLevels?: EffortLevel[];
  price?: ModelPrice;
  /** 窗口的出处;上屏显示的就是它。 */
  source: CapabilitySource;
  priceSource?: CapabilitySource;
};

/**
 * 生效的能力数据:模型对象里明写的 > models.dev > 供应商级配置 > 假设。
 * 每项独立回退(窗口可能来自登记簿而强度档来自配置)。
 */
export function resolveCapabilities(
  providerName: string,
  p: ProviderConfig,
  modelId: string,
  registry: Registry | undefined,
): Capabilities {
  const m = modelConfig(p, modelId);
  const hit = registry
    ? lookupModel(registry, registryProviderId(providerName, p), modelId)
    : undefined;
  const reg = hit ? modelConfigFromRegistry(modelId, hit) : undefined;
  const contextWindow = m.contextWindow ?? reg?.contextWindow ?? p.contextWindow ?? ASSUMED_CONTEXT;
  const source: CapabilitySource =
    m.contextWindow !== undefined
      ? "config"
      : reg?.contextWindow !== undefined
        ? "models.dev"
        : p.contextWindow !== undefined
          ? "config"
          : "assumed";
  const maxTokens = m.maxTokens ?? reg?.maxTokens ?? p.maxTokens;
  const effortLevels = m.effortLevels ?? reg?.effortLevels ?? p.effortLevels;
  const price = m.price ?? reg?.price;
  return {
    contextWindow,
    source,
    ...(maxTokens !== undefined && { maxTokens }),
    ...(effortLevels && { effortLevels }),
    ...(price && { price, priceSource: m.price ? "config" : "models.dev" }),
  };
}

/** 模型选择器只显示可核对的窗口与出处;静态价目不在默认界面出现。 */
export function describeCapabilities(caps: Capabilities): string {
  return [`${fmtWindow(caps.contextWindow)} ctx`, caps.source].join(" · ");
}

export type Inferred = {
  /** 写进配置的对象:登记簿命中只写名字(数据保持活的),抄来的带数据。 */
  model: ModelConfig;
  /** 写进去之后生效的能力数据。 */
  caps: Capabilities;
  /** 数据从哪来,原样显示在行上。 */
  source: string;
};

/** 最像的已配置模型:最长公共前缀,至少 6 个字符才算像。 */
export function closestConfigured(p: ProviderConfig, modelId: string): ModelConfig | undefined {
  let best: { m: string | ModelConfig; len: number } | undefined;
  for (const m of p.models) {
    const name = typeof m === "string" ? m : m.name;
    let i = 0;
    while (i < name.length && i < modelId.length && name[i] === modelId[i]) i++;
    if (i >= 6 && (!best || i > best.len)) best = { m, len: i };
  }
  if (!best) return undefined;
  return typeof best.m === "string" ? { name: best.m } : best.m;
}

/** 给一个配置里没有的模型推出配置:三级回退,标出处。 */
export function inferModelConfig(
  providerName: string,
  p: ProviderConfig,
  modelId: string,
  registry: Registry | undefined,
): Inferred {
  const hit = registry && lookupModel(registry, registryProviderId(providerName, p), modelId);
  const withIt = (model: ModelConfig): ProviderConfig => ({ ...p, models: [...p.models, model] });
  if (hit?.limit?.context) {
    // 登记簿命中:配置里只留名字,窗口与价格每天跟着登记簿走。
    const model: ModelConfig = { name: modelId };
    return {
      model,
      caps: resolveCapabilities(providerName, withIt(model), modelId, registry),
      source: "models.dev",
    };
  }
  const sibling = closestConfigured(p, modelId);
  if (sibling) {
    const { name: _name, ...rest } = sibling;
    const model: ModelConfig = { ...rest, name: modelId };
    return {
      model,
      caps: resolveCapabilities(providerName, withIt(model), modelId, registry),
      source: `copied from ${sibling.name}`,
    };
  }
  const model: ModelConfig = { name: modelId };
  const caps = resolveCapabilities(providerName, withIt(model), modelId, registry);
  return { model, caps, source: `assumed ${fmtWindow(caps.contextWindow)} context` };
}

/** 一行说明:窗口与出处,给选择器的行注。 */
export function describeInferred(inf: Inferred): string {
  const k = inf.caps;
  return [`${fmtWindow(k.contextWindow)} ctx`, inf.source].join(" · ");
}

export function fmtWindow(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1024)}k`;
}

/** 已配置模型的一行注:生效的窗口、价格、出处;配置覆盖了登记簿且两者不同时,把登记簿的值也带上。 */
export function capabilityNote(
  registry: Registry | undefined,
  providerName: string,
  p: ProviderConfig,
  modelId: string,
): string {
  const caps = resolveCapabilities(providerName, p, modelId, registry);
  const hit = registry
    ? lookupModel(registry, registryProviderId(providerName, p), modelId)
    : undefined;
  const reg = hit?.limit?.context;
  const note = describeCapabilities(caps);
  return caps.source === "config" && reg !== undefined && reg !== caps.contextWindow
    ? `${note} (models.dev says ${fmtWindow(reg)})`
    : note;
}
