// 供应商配置:哪家、什么协议、key 从哪来、模型名怎么匹配到家,以及每个模型的能力数据。
// 分层原则:协议形状写在适配器代码里(多年不变);模型名、窗口、强度集合、thinking 模式是数据,放这里;
// API 新增的参数用 extraBody / extraHeaders 逐字透传,不必等代码。key 只从配置字段或环境变量读取。
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalConfig } from "./approval.js";
import type { CompactionAcceptance } from "./compaction-presets.js";
import { lockFile } from "./file-lock.js";
import type { CompactionTrigger } from "./loop.js";
import type { EffortLevel, Provider } from "./provider.js";
import { anthropic, type ThinkingMode } from "./providers/anthropic.js";
import { type OpenAIDialect, openaiCompat } from "./providers/openai-chat.js";
import { openaiResponses } from "./providers/openai-responses.js";
import { defaultPreset } from "./settings.js";
import type { StatusStyle } from "./status-bar.js";
import type { SubagentApproval, SubagentType } from "./subagent.js";
import type { DescriptionLevel } from "./tools.js";

/** 每百万 token 的价格(美元)。缺哪项就不计哪项;整个缺省 = 不显示费用。 */
/** 工具结果在对话流里的可见度:count 只报行数,head 前几行,tail 后几行,all 全部。 */
export type ResultView = "count" | "head" | "tail" | "all";

export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** 单个模型的能力数据。字符串形式等价于只有 name。 */
export type ModelConfig = {
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 支持的强度级别;请求了不支持的会向下回退。不写 = 不校验。 */
  effortLevels?: EffortLevel[];
  /** Anthropic:adaptive(4.7+/5 系)或 budget(4.6 及更早)。 */
  thinkingMode?: ThinkingMode;
  /** 逐字合并进请求正文。 */
  extraBody?: Record<string, unknown>;
  /** 价格数据,只用于显示费用;变价是常态,verifiedAt 标核对日期。 */
  price?: ModelPrice;
};

export type ProviderConfig = {
  /** openai = chat completions(DeepSeek、多数中转站);openai-responses = GPT 系推理摘要可见的那条;anthropic = Messages。 */
  protocol: "openai" | "openai-responses" | "anthropic";
  /** openai-responses:推理摘要档位,缺省 auto;none 不要摘要。 */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  baseUrl: string;
  /** 直接写在配置里的 key:演示与脚本用;正常用法是 /login 写进凭据文件,或 apiKeyEnv。 */
  apiKey?: string;
  /** 存放 key 的环境变量名。 */
  apiKeyEnv?: string;
  /** 该家的模型;字符串或带能力数据的对象。用于按模型名匹配供应商。 */
  models: (string | ModelConfig)[];
  /** 供应商级缺省,模型级可覆盖。 */
  contextWindow?: number;
  maxTokens?: number;
  /** thinking 模型的推理字段名(DeepSeek 为 reasoning_content),带工具多轮时必须原样回传。 */
  reasoningField?: string;
  /** openai 协议的方言:强度参数写法不同。 */
  dialect?: OpenAIDialect;
  thinkingMode?: ThinkingMode;
  effortLevels?: EffortLevel[];
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** Anthropic 提示缓存断点,缺省开;中转站不支持时关。 */
  promptCache?: boolean;
  /** 流停滞判定毫秒数,缺省 90000;0 = 不限。 */
  stallTimeoutMs?: number;
  /** 重试参数;缺省 2 次、500ms 起、×2 退避、上限 8s(与两大官方 SDK 一致)。 */
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
};

/** 工具描述风格 = 拼接层级:brief 只有核心;explain(缺省)加指导;rules 再加 ALWAYS / NEVER 规则。descriptions 逐工具覆盖。 */
export type ToolPromptStyle = DescriptionLevel;
export type ToolPromptsConfig = {
  style?: ToolPromptStyle;
  descriptions?: Record<string, string>;
};

/** 系统提示词的段名:哪几段、什么顺序由配置或预设决定。 */
export type PromptSectionName = "role" | "env" | "instructions" | "memory" | "skills" | "append";

export type SkillsConfig = {
  /** 内置来源名或目录路径 → on/off;关闭的自定义来源仍保留,可重新开启。 */
  sources?: Record<string, "on" | "off">;
  mode?: "manual" | "auto";
  /** all 随发现目录增长;数组固定到具体名称,空数组不提供任何技能。 */
  include?: "all" | string[];
  load?: "read" | "tool";
};

export type PromptConfig = {
  /** 要哪几段、什么顺序;缺省 role, env, instructions, memory, skills, append。 */
  sections?: PromptSectionName[];
  /** 项目指令与记忆放 system(缺省)还是首条 user 消息。 */
  instructionsAs?: "system" | "user";
  /** 跨会话记忆:缺省关。开了才读 AGENTS.md 里的记忆节并装上 remember 工具。 */
  memory?: boolean;
  /** 默认手动 /名 调用;自动模式仅提供所选目录,不限制已有的文件读取能力。 */
  skills?: SkillsConfig;
};

/**
 * 预设:一组命名好的启动参数,`--preset 名`。命令行显式给的参数仍然优先。
 * 指令文件在这里当"预设指令器":不同预设指向不同的 system-prompt / append 文件与段组合。
 */
export type Preset = {
  /** null 显式使用内置选择,不继承较低层 defaults;省略则继承。 */
  model?: string | null;
  effort?: string | null;
  compaction?: string;
  /** all = 不问;ask = 每个调用都问;policy(缺省)= 按 approval 规则。 */
  approve?: "all" | "ask" | "policy";
  /** 审批规则,覆盖全局的 approval。 */
  approval?: ApprovalConfig;
  /** 执行槽:sequential(缺省)| parallel。 */
  execution?: "sequential" | "parallel";
  /** 插话槽:step(缺省,下一步就注入)| turn(等模型停止调用工具)。 */
  steering?: "step" | "turn";
  /** 保留策略:"tokens 20000" 或 "ratio 0.3";缺省 keepRecentTokens(min(20000, window/4))。 */
  preservation?: string | null;
  /** 压缩触发:threshold(缺省,到阈值自动压)| manual(只在 /compact)| remind(到阈值只提示)。 */
  compactionTrigger?: CompactionTrigger;
  /** 自动压缩阈值 = 窗口 − 这个余量;缺省 32000。 */
  compactionReserve?: number;
  /** 提早触发压缩的窗口比例;0 = 关闭,开启建议 0.8。 */
  compactionRatio?: number;
  /** 内置摘要指令模板名或完整 Markdown 文件路径。 */
  compactionPrompt?: string;
  /** 仅覆盖摘要请求的输出额度;0 沿用供应商配置。 */
  compactionMaxTokens?: number;
  /** 完整摘要的应用规则;取消、截断与空结果始终不能应用。 */
  compactionAcceptance?: CompactionAcceptance;
  /** 工具结果初始折叠;缺省 true,Ctrl+O 切换。 */
  fold?: boolean;
  /** 折叠时保留的结果行数;缺省 5。 */
  foldLines?: number;
  /** 每个工具的结果可见度:count 只报行数,head 前几行,tail 后几行,all 全部;没写的工具按 head。 */
  results?: Record<string, ResultView>;
  /** 事实附注:repeats 同样参数的重复失败,slow 比中位耗时慢得多的调用,date 日期变化。缺省全开。 */
  facts?: { repeats?: boolean; slow?: boolean; date?: boolean };
  /** plan 工具总开关:关了定义不发(每次请求省 170–250 token)、复述不做。缺省开。 */
  plan?: boolean;
  /** 工具集:disable 列出的内置工具不装(/tools 在会话里还能开关)。 */
  tools?: { disable?: string[] };
  /** 计划复述:连续这么多步没碰 plan 且还有未完成项就把计划贴到末尾;0 = 关闭计步复述。缺省 0。 */
  planReminder?: number;
  /** 账簿:保持展开的最新步数,更早的折成一行;缺省 3,0 = 从不自动折。 */
  foldSteps?: number;
  statusStyle?: StatusStyle;
  statusWidgets?: string[];
  /** 是否显示基于已报告 token 和目录单价的估算金额;缺省关闭,不代表账单。 */
  showCostEstimate?: boolean;
  /** 屏幕模式:alt(缺省,备用屏,头尾固定、自己滚、鼠标、搜索)| main(主屏,保留终端回滚)。 */
  screen?: "alt" | "main";
  /** 桌面通知:unfocused(缺省,只在终端失焦时)| always | off。回合结束与等审批时发。 */
  notify?: "unfocused" | "always" | "off";
  /** TUI 启动后异步检查新版,仅提示,不自动安装。 */
  checkUpdates?: boolean;
  /** 扩展模块路径列表。 */
  extensions?: string[];
  /** 切换会话时重新连接的 MCP 服务器名;其它正常连接默认复用。 */
  mcpReconnect?: string[];
  saveInputs?: boolean;
  systemPromptFile?: string;
  appendSystemPromptFile?: string;
  subagent?: boolean;
  maxSteps?: number | null;
  prompt?: PromptConfig;
  /** 工具描述风格。 */
  toolPrompts?: ToolPromptStyle;
};

export type KernelConfig = {
  /** 缺省模型;命令行 --model 可覆盖。 */
  default: string;
  /** 模板里的能力数据核对日期。过期是常态,发现靠 /models。 */
  verifiedAt?: string;
  providers: Record<string, ProviderConfig>;
  /** 系统提示词组装的全局缺省。 */
  prompt?: PromptConfig;
  /**
   * 全局缺省:与预设同形,每个可选项都能写在这里。解析顺序 命令行 > --preset 指的预设 > defaults > 内置缺省。
   * 模板把每个旋钮的内置缺省值都列出来,改哪个就改哪个。
   */
  defaults?: Preset;
  /** 命名预设。 */
  presets?: Record<string, Preset>;
  /** 会话文件目录;缺省工作目录下的 sessions/。环境变量 CLAROOK_SESSIONS 优先。 */
  sessionsDir?: string;
  /** 审批规则:缺省只读工具放行、其余问人、cwd 之外必问。 */
  approval?: ApprovalConfig;
  /** 工具描述风格与逐工具覆盖。 */
  toolPrompts?: ToolPromptsConfig;
  /** 子 agent(task 工具)的设置;开关本身在 defaults.subagent / --subagent。 */
  subagents?: SubagentsConfig;
  /** MCP 桥接的配置。内核不解释它;形状归 cli/mcp/config.ts。 */
  mcp?: Record<string, unknown>;
  /** fetch 工具的请求预算:超时、字节上限、重定向次数。 */
  fetch?: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    userAgent?: string;
    /** 会话内缓存存活毫秒数,缺省 15 分钟;0 关。 */
    cacheTtlMs?: number;
  };
};

export type SubagentsConfig = {
  /** 子的工具调用怎么过审:inherit(缺省)沿用父的;allow 不问;{ deny: [...] } 在父的基础上再收紧。 */
  approval?: SubagentApproval;
  /** 子的步数上限;不给就不设上限,靠续聊与人的打断。 */
  maxSteps?: number;
  /** 嵌套深度,缺省 1:子没有 task 工具。 */
  depth?: number;
  /** 缺省类型,缺省 default。 */
  defaultType?: string;
  /** 类型注册表:名 → 说明、系统提示词、工具子集、模型、缺省范围、步数上限;叠在内置 default 之上。 */
  types?: Record<string, SubagentType>;
};

/** 用户目录:环境变量 CLAROOK_HOME 指定,否则 ~/.clarook。 */
export function clarookHome(env = process.env): string {
  return env.CLAROOK_HOME?.trim() || join(homedir(), ".clarook");
}

/** 配置文件路径;环境变量 CLAROOK_CONFIG 可改(多套配置、测试用)。 */
export const DEFAULT_CONFIG_PATH =
  process.env.CLAROOK_CONFIG?.trim() || join(clarookHome(), "config.json");

export const CONFIG_TEMPLATE: KernelConfig = {
  default: "deepseek-flash",

  // 每个可选项的内置缺省值,从开关登记表(settings.ts)生成。命令行与预设可以覆盖;删掉某一项等于用内置缺省。
  defaults: defaultPreset(),
  subagents: {
    approval: "inherit",
    depth: 1,
    defaultType: "default",
    types: {},
  },
  providers: {
    deepseek: {
      protocol: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      dialect: "deepseek",
      reasoningField: "reasoning_content",
      // 窗口、输出上限、价格不预填:缺省来自 models.dev(内置快照,每天刷新);想覆盖就在模型对象里写。
      models: [
        { name: "deepseek-flash", effortLevels: ["off", "low", "high", "max"] },
        { name: "deepseek-v4-pro", effortLevels: ["off", "low", "high", "max"] },
      ],
    },
    anthropic: {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: [
        { name: "claude-opus-5", effortLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
        { name: "claude-sonnet-5", effortLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
        {
          name: "claude-haiku-4-5-20251001",
          thinkingMode: "budget",
          effortLevels: ["off", "low", "medium", "high"],
        },
      ],
    },
    openai: {
      // GPT 系走 Responses 协议:推理摘要可见,推理正文加密回传;中转站多数只支持 chat completions,另起一条 protocol: openai。
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      reasoningSummary: "auto",
      models: [
        { name: "gpt-5.5", effortLevels: ["off", "low", "medium", "high", "xhigh"] },
        { name: "gpt-5.6", effortLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
      ],
    },
  },
};

/** 模型名列表(兼容字符串与对象两种写法)。 */
export function modelNames(p: ProviderConfig): string[] {
  return p.models.map((m) => (typeof m === "string" ? m : m.name));
}

/** 某模型的能力数据;字符串写法或未列出的模型返回只有 name 的对象。 */
export function modelConfig(p: ProviderConfig, name: string): ModelConfig {
  const found = p.models.find((m) => (typeof m === "string" ? m : m.name) === name);
  return typeof found === "object" ? found : { name };
}

/** 读配置;文件不存在时写入模板并返回它(key 字段留空,由用户填)。 */
// 临时文件与目标同目录;失败保留旧文件,不会留下半份 JSON。
function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function readConfig(path: string): KernelConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`failed to parse config ${path}: invalid JSON`);
  }
  return validate(parsed, path);
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): { config: KernelConfig; created: boolean } {
  if (existsSync(path)) return { config: readConfig(path), created: false };
  const writer = lockFile(path);
  try {
    const created = !existsSync(writer.path);
    if (created) writeJson(writer.path, CONFIG_TEMPLATE);
    return { config: readConfig(writer.path), created };
  } finally {
    writer.release();
  }
}

/** 回调只描述本次改动;在锁内读最新值、校验、原子替换,成功后才更新调用方快照。 */
export function updateConfig(
  change: (current: KernelConfig) => KernelConfig,
  path = DEFAULT_CONFIG_PATH,
): KernelConfig {
  const writer = lockFile(path);
  try {
    const current = existsSync(writer.path)
      ? readConfig(writer.path)
      : structuredClone(CONFIG_TEMPLATE);
    const next = validate(change(current), path);
    writer.assertHeld();
    writeJson(writer.path, next);
    return next;
  } finally {
    writer.release();
  }
}

/** 凭据文件:~/.clarook/credentials.json,环境变量 CLAROOK_CREDENTIALS 可改。key 只进这里,配置文件里不出现。 */
export function credentialsPath(env = process.env): string {
  return env.CLAROOK_CREDENTIALS?.trim() || join(clarookHome(env), "credentials.json");
}

export type Credentials = Record<string, { apiKey: string }>;

export function loadCredentials(path = credentialsPath()): Credentials {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // JSON 解析器会带上原文片段,其中可能包含凭据。
    throw new Error(`failed to parse credentials ${path}: invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error(`credentials is not an object: ${path}`);
  const out: Credentials = {};
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    const key = (v as { apiKey?: unknown } | null)?.apiKey;
    if (typeof key === "string" && key.trim()) out[name] = { apiKey: key.trim() };
  }
  return out;
}

/** 写入一家的 key(合并已有),文件权限 0600。 */
export function saveCredential(
  providerName: string,
  apiKey: string,
  path = credentialsPath(),
): void {
  const writer = lockFile(path);
  try {
    const next = { ...loadCredentials(writer.path), [providerName]: { apiKey: apiKey.trim() } };
    writer.assertHeld();
    writeJson(writer.path, next);
  } finally {
    writer.release();
  }
}

export type KeySource = "env" | "credentials" | "config";

/** key 从哪来:环境变量 > 凭据文件 > 配置里的 apiKey(演示与脚本用)。没有返回 undefined。 */
export function findApiKey(
  name: string,
  p: ProviderConfig,
  env = process.env,
  credentials?: Credentials,
): { key: string; source: KeySource } | undefined {
  if (p.apiKeyEnv) {
    const v = env[p.apiKeyEnv];
    if (v?.trim()) return { key: v.trim(), source: "env" };
  }
  const creds = credentials ?? loadCredentials(credentialsPath(env));
  const stored = creds[name]?.apiKey;
  if (stored) return { key: stored, source: "credentials" };
  if (p.apiKey?.trim()) return { key: p.apiKey.trim(), source: "config" };
  return undefined;
}

/** /login 保存供应商 key:进凭据文件,不碰配置。返回配置原样。 */
export function setApiKey(
  config: KernelConfig,
  providerName: string,
  apiKey: string,
  path = credentialsPath(),
): KernelConfig {
  if (!config.providers[providerName]) {
    throw new Error(
      `unknown provider "${providerName}"; options: ${Object.keys(config.providers).join(", ")}`,
    );
  }
  saveCredential(providerName, apiKey, path);
  return config;
}

/** 修改缺省模型并落盘。 */
export function setDefaultModel(model: string, path = DEFAULT_CONFIG_PATH): KernelConfig {
  return updateConfig((current) => {
    resolveModel(current, model);
    return { ...current, default: model };
  }, path);
}

/** 修改指定供应商的一个模型,保留其它进程已保存的模型及配置。 */
export function addModel(
  providerName: string,
  model: ModelConfig,
  path = DEFAULT_CONFIG_PATH,
): KernelConfig {
  return updateConfig((current) => {
    const p = current.providers[providerName];
    if (!p) throw new Error(`unknown provider "${providerName}"`);
    const models = p.models.filter((m) => (typeof m === "string" ? m : m.name) !== model.name);
    return {
      ...current,
      providers: { ...current.providers, [providerName]: { ...p, models: [...models, model] } },
    };
  }, path);
}

function validate(raw: unknown, path: string): KernelConfig {
  const c = raw as Partial<KernelConfig>;
  if (!c || typeof c !== "object" || typeof c.default !== "string" || !c.providers) {
    throw new Error(`config is missing default or providers: ${path}`);
  }
  for (const values of [c.defaults, ...Object.values(c.presets ?? {})]) {
    if (values && "trace" in values)
      throw new Error(
        "Remove obsolete trace from defaults/presets; session recording is now always enabled",
      );
  }
  for (const [name, p] of Object.entries(c.providers)) {
    if (
      p.protocol !== "openai" &&
      p.protocol !== "anthropic" &&
      p.protocol !== "openai-responses"
    ) {
      throw new Error(`provider ${name}: protocol must be openai, openai-responses or anthropic`);
    }
    if (typeof p.baseUrl !== "string" || !Array.isArray(p.models)) {
      throw new Error(`provider ${name} is missing baseUrl or models`);
    }
    for (const m of p.models) {
      const ok = typeof m === "string" || (typeof m === "object" && typeof m?.name === "string");
      if (!ok)
        throw new Error(`provider ${name}: models entries must be strings or objects with a name`);
    }
  }
  return c as KernelConfig;
}

export type Resolved = {
  providerName: string;
  provider: ProviderConfig;
  model: string;
  contextWindow: number;
  maxTokens?: number;
  effortLevels?: EffortLevel[];
  thinkingMode?: ThinkingMode;
  extraBody?: Record<string, unknown>;
  price?: ModelPrice;
};

/**
 * 模型名 → 供应商。三级匹配:①"供应商/模型" 显式写法;②某家 models 列表包含该名;
 * ③按前缀猜(claude-* → anthropic 协议的那家,deepseek-* / gpt-* 同理)。都不中就报错并列出可选项。
 */
export function resolveModel(config: KernelConfig, requested?: string): Resolved {
  const name = requested ?? config.default;
  const entries = Object.entries(config.providers);

  const slash = name.indexOf("/");
  if (slash > 0) {
    const pn = name.slice(0, slash);
    const p = config.providers[pn];
    if (!p)
      throw new Error(`unknown provider "${pn}"; options: ${entries.map(([n]) => n).join(", ")}`);
    return finish(pn, p, name.slice(slash + 1));
  }

  const listed = entries.find(([, p]) => modelNames(p).includes(name));
  if (listed) return finish(listed[0], listed[1], name);

  const guess = entries.find(([pn, p]) => {
    if (name.startsWith("claude-")) return p.protocol === "anthropic";
    if (name.startsWith("deepseek-")) return pn === "deepseek" || p.baseUrl.includes("deepseek");
    if (name.startsWith("gpt-") || /^o\d/.test(name)) return p.baseUrl.includes("openai.com");
    return false;
  });
  if (guess) return finish(guess[0], guess[1], name);

  const all = entries.flatMap(([pn, p]) => modelNames(p).map((m) => `${pn}/${m}`));
  throw new Error(`no provider matches model "${name}". Configured models:\n  ${all.join("\n  ")}`);

  function finish(pn: string, p: ProviderConfig, model: string): Resolved {
    const m = modelConfig(p, model);
    const maxTokens = m.maxTokens ?? p.maxTokens;
    const effortLevels = m.effortLevels ?? p.effortLevels;
    const thinkingMode = m.thinkingMode ?? p.thinkingMode;
    const extraBody = p.extraBody || m.extraBody ? { ...p.extraBody, ...m.extraBody } : undefined;
    return {
      providerName: pn,
      provider: p,
      model,
      contextWindow: m.contextWindow ?? p.contextWindow ?? 128000,
      ...(maxTokens !== undefined && { maxTokens }),
      ...(effortLevels && { effortLevels }),
      ...(thinkingMode && { thinkingMode }),
      ...(extraBody && { extraBody }),
      ...(m.price && { price: m.price }),
    };
  }
}

/** 取 key:沿用 findApiKey 的环境变量、凭据文件、配置字段顺序;缺失时指出填写入口。 */
export function resolveApiKey(name: string, p: ProviderConfig, env = process.env): string {
  const found = findApiKey(name, p, env);
  if (found) return found.key;
  const where = p.apiKeyEnv ? `set env var ${p.apiKeyEnv}, ` : "";
  throw new Error(
    `no API key for provider ${name}. Run /login in the TUI, ${where}or add it to ${credentialsPath(env)}`,
  );
}

export function createProvider(r: Resolved, apiKey: string): Provider {
  // 手工构造的 Resolved 可能只填了供应商级字段,这里统一回落。
  const effortLevels = r.effortLevels ?? r.provider.effortLevels;
  const extraBody = r.extraBody ?? r.provider.extraBody;
  const maxTokens = r.maxTokens ?? r.provider.maxTokens;
  const thinkingMode = r.thinkingMode ?? r.provider.thinkingMode;
  const shared = {
    apiKey,
    model: r.model,
    ...(effortLevels && { effortLevels }),
    ...(extraBody && { extraBody }),
    ...(r.provider.extraHeaders && { extraHeaders: r.provider.extraHeaders }),
    ...(r.provider.stallTimeoutMs !== undefined && { stallTimeoutMs: r.provider.stallTimeoutMs }),
    ...(r.provider.retry && { retry: r.provider.retry }),
    ...(maxTokens !== undefined && { maxTokens }),
  };
  if (r.provider.protocol === "anthropic") {
    return anthropic({
      baseUrl: r.provider.baseUrl,
      ...shared,
      ...(thinkingMode && { thinkingMode }),
      ...(r.provider.promptCache !== undefined && { promptCache: r.provider.promptCache }),
    });
  }
  if (r.provider.protocol === "openai-responses") {
    return openaiResponses({
      baseUrl: r.provider.baseUrl,
      ...shared,
      ...(r.provider.reasoningSummary && { reasoningSummary: r.provider.reasoningSummary }),
    });
  }
  return openaiCompat({
    baseUrl: r.provider.baseUrl,
    ...shared,
    ...(r.provider.reasoningField && { reasoningField: r.provider.reasoningField }),
    ...(r.provider.dialect && { dialect: r.provider.dialect }),
  });
}
