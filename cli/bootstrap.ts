// 两个入口(tui.ts 交互、run.ts 一次性)共用的组装:配置与模型、工具集、系统提示词、开始会话。只做拼装,不含界面。
// 参数解析在 args.ts,压缩策略装载在 strategies.ts,扩展模块在 extensions.ts,会话文件在 sessions.ts;
// 这里把它们再导出,入口与测试从 bootstrap 一处 import(重构块 6)。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  addModel,
  clarookHome,
  createProvider,
  DEFAULT_CONFIG_PATH,
  findApiKey,
  type KernelConfig,
  loadConfig,
  modelNames,
  resolveApiKey,
  resolveModel,
  setApiKey,
  setDefaultModel,
  type ToolPromptsConfig,
  updateConfig,
} from "../src/config.js";
import { now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { planTool } from "../src/plan.js";
import { defaultPreset, setSetting } from "../src/settings.js";
import { replaceSetup } from "../src/setup.js";
import type { Tool } from "../src/tools.js";
import { applyPreset, type CommonArgs, parseCommonArgs } from "./args.js";
import type { ModelChoice, ModelSettings } from "./model-settings.js";
import {
  buildSystemPrompt,
  type DiscoverOptions,
  findGitRoot,
  type PromptSection,
  type Skill,
} from "./prompt.js";
import {
  capabilityNote,
  fetchRegistry,
  inferModelConfig,
  loadRegistrySync,
  type Registry,
  resolveCapabilities,
} from "./registry.js";
import { openSession, SESSIONS_DIR } from "./sessions.js";
import { applyToolPrompts } from "./tool-prompts.js";
import { createBashTool } from "./tools/bash.js";
import { createFetchTool, type FetchConfig } from "./tools/fetch.js";
import { editTool, readTool, writeTool } from "./tools/fs.js";
import { createRememberTool, type MemoryFiles } from "./tools/memory.js";
import { globTool, grepTool } from "./tools/search.js";
import { createSkillTool } from "./tools/skill.js";

export * from "./args.js";
export * from "./extensions.js";
export {
  forkSession,
  latestSession,
  newSessionPath,
  openSession,
  SESSIONS_DIR,
  sessionsDir,
} from "./sessions.js";
export * from "./strategies.js";
export { DEFAULT_CONFIG_PATH };

export const BASE_PROMPT =
  "You are a coding assistant working on the user's machine. The working directory is the current directory. " +
  "Prefer grep/glob to locate, read to read, edit for exact changes, and bash to run commands. Keep answers concise.";

export type Bootstrap = {
  config: KernelConfig;
  configCreated: boolean;
  choose(name?: string): ModelChoice;
  /** 同 choose,但缺 key 时返回占位选择(unavailable 带原因)而不是抛错。 */
  chooseOrNone(name?: string): ModelChoice;
  settings: ModelSettings;
  /** 把预设与配置缺省并进参数:显式参数 > 预设 > 配置 prompt 缺省 > 内置缺省。 */
  resolve(args: CommonArgs): CommonArgs;
};

export const NO_PROVIDER = "none";

/** 占位 provider:任何请求都失败并指向 /login;/models 也不可用。 */
export function noProviderChoice(): ModelChoice {
  return {
    provider: {
      model: NO_PROVIDER,
      async complete() {
        throw new Error("No provider configured. Run /login to add an API key.");
      },
    },
    model: NO_PROVIDER,
    providerName: NO_PROVIDER,
    contextWindow: 128000,
  };
}

export function bootstrap(): Bootstrap {
  const loaded = loadConfig();
  let config = loaded.config;
  // 能力数据:模型对象里明写的 > models.dev > 供应商级配置 > 假设;出处随选择一起带到界面。
  const choose = (name?: string): ModelChoice => {
    const r = resolveModel(config, name);
    const caps = resolveCapabilities(r.providerName, r.provider, r.model, registryNow);
    const apiKey = resolveApiKey(r.providerName, r.provider);
    const resolved = {
      ...r,
      contextWindow: caps.contextWindow,
      ...(caps.maxTokens !== undefined && { maxTokens: caps.maxTokens }),
      ...(caps.effortLevels && { effortLevels: caps.effortLevels }),
      ...(caps.price && { price: caps.price }),
    };
    return {
      provider: createProvider(resolved, apiKey),
      model: r.model,
      providerName: r.providerName,
      contextWindow: caps.contextWindow,
      capabilitySource: caps.source,
      ...(caps.effortLevels && { effortLevels: caps.effortLevels }),
      ...(caps.price && { price: caps.price }),
    };
  };
  /** 没有 key 也要进界面:拿不到 provider 时返回占位,界面据此打开登录对话框。 */
  const chooseOrNone = (name?: string): ModelChoice => {
    try {
      return choose(name);
    } catch (err) {
      const message = (err as Error).message;
      if (!/no API key/.test(message)) throw err;
      return { ...noProviderChoice(), unavailable: message };
    }
  };
  const settings: ModelSettings = {
    defaultModel: () => config.default,
    priceFor: (model) => {
      try {
        return resolveModel(config, model).price;
      } catch {
        return undefined;
      }
    },
    listModels: () =>
      Object.entries(config.providers).flatMap(([pn, p]) => modelNames(p).map((m) => `${pn}/${m}`)),
    switchModel: (name) => choose(name),
    setKey: (providerName, key) => {
      config = setApiKey(config, providerName, key);
    },
    providers: () =>
      Object.entries(config.providers).map(([name, p]) => ({
        name,
        protocol: p.protocol,
        ...(p.apiKeyEnv && { env: p.apiKeyEnv }),
        ...(() => {
          const found = findApiKey(name, p);
          return found ? { keySource: found.source } : {};
        })(),
        models: modelNames(p),
      })),
    verifyKey: async (providerName, key, signal) => {
      const p = config.providers[providerName];
      if (!p) throw new Error(`unknown provider "${providerName}"`);
      const r = resolveModel(config, `${providerName}/${modelNames(p)[0] ?? ""}`);
      const provider = createProvider(r, key);
      if (!provider.listModels) return [];
      return provider.listModels(signal);
    },
    setDefault: (model) => {
      config = setDefaultModel(model);
    },
    // 配置里没有的模型:models.dev 命中只写名字(数据保持活的)→ 抄最像的 → 只写名字按假设。
    describeModel: async (providerName, modelId) => {
      const p = config.providers[providerName];
      if (!p) throw new Error(`unknown provider "${providerName}"`);
      return inferModelConfig(providerName, p, modelId, await registry());
    },
    addModel: (providerName, model) => {
      config = addModel(providerName, model);
    },
    // /settings:只改 defaults 下的那一个键,其余原样落盘。
    saveSetting: (key, value) => {
      config = updateConfig((current) => {
        if (key === "model" && value != null) resolveModel(current, String(value));
        return { ...current, defaults: setSetting(current.defaults, key, value) };
      });
    },
    saveSettings: (values) => {
      config = updateConfig((current) => {
        let defaults = current.defaults ?? {};
        for (const [key, value] of Object.entries(values)) {
          if (key === "model" && value != null) resolveModel(current, String(value));
          defaults = setSetting(defaults, key, value);
        }
        return { ...current, defaults };
      });
    },
    listPresets: () =>
      Object.entries(config.presets ?? {}).map(([name, values]) => ({
        name,
        values: structuredClone(values),
      })),
    savePreset: (name, values) => {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) ||
        ["recommended", "__proto__", "constructor", "prototype"].includes(name)
      ) {
        throw new Error(
          "Use 1–64 letters, digits, hyphens or underscores; choose a name other than recommended.",
        );
      }
      config = updateConfig((current) => {
        if (Object.hasOwn(current.presets ?? {}, name))
          throw new Error(`Preset ${name} already exists. Choose a new name.`);
        const next = {
          ...current,
          presets: { ...current.presets, [name]: structuredClone(values) },
        };
        const args = applyPreset(parseCommonArgs(["--preset", name]), next);
        if (args.model) resolveModel(next, args.model);
        return next;
      });
    },
    usePreset: (name) => {
      config = updateConfig((current) => {
        const values = name === "recommended" ? defaultPreset() : current.presets?.[name];
        if (!values) throw new Error(`No preset named ${name}.`);
        const next = { ...current, defaults: replaceSetup(current.defaults, values) };
        const args = applyPreset(parseCommonArgs([]), next);
        if (args.model) resolveModel(next, args.model);
        return next;
      });
    },
    capabilityNote: async (providerName, modelId) => {
      const p = config.providers[providerName];
      if (!p) return "";
      return capabilityNote(await registry(), providerName, p, modelId);
    },
  };
  // 启动先用缓存或内置快照,后台检查 24 小时有效期;本次启动只请求一次,失败沿用旧数据。
  let registryNow: Registry = loadRegistrySync();
  let registryOnce: Promise<Registry | undefined> | undefined;
  const registry = () => {
    registryOnce ??= fetchRegistry().then((r) => {
      if (r) registryNow = r;
      return registryNow;
    });
    return registryOnce;
  };
  void registry();
  return {
    get config() {
      return config;
    },
    configCreated: loaded.created,
    choose,
    chooseOrNone,
    settings,
    resolve: (args) => applyPreset(args, config),
  };
}

/** 记忆文件:项目级 = git 根(或 cwd)的 AGENTS.md;用户级 = ~/.clarook/AGENTS.md。 */
export function memoryFiles(cwd = process.cwd(), home = clarookHome()): MemoryFiles {
  const projectRoot = findGitRoot(cwd) ?? resolve(cwd);
  return { project: join(projectRoot, "AGENTS.md"), user: join(home, "AGENTS.md") };
}

/** 创建内置工具。会话和子任务的资源装配由 session-runtime 负责。 */
export function buildTools(
  opts: {
    memory?: MemoryFiles;
    skills?: Skill[];
    fetchConfig?: FetchConfig;
    toolPrompts?: ToolPromptsConfig;
    plan?: boolean;
  } = {},
): Tool[] {
  // 每次组装复制一份工具对象:描述风格槽原地改描述,不能碰模块级单例。
  const base: Tool[] = [
    readTool,
    writeTool,
    editTool,
    createBashTool(),
    grepTool,
    globTool,
    createFetchTool({ ...(opts.fetchConfig && { config: opts.fetchConfig }) }),
    ...((opts.plan ?? true) ? [planTool] : []),
  ].map((t) => ({ ...t }));
  if (opts.memory) base.push(createRememberTool(opts.memory));
  if (opts.skills?.some((s) => !s.disableModelInvocation)) base.push(createSkillTool(opts.skills));
  applyToolPrompts(base, opts.toolPrompts);
  return base;
}

/** 系统提示词:--system-prompt 整段替换,--append-system-prompt 追加;否则 角色 → 环境 → 项目指令。 */
type PromptArgs = Pick<
  CommonArgs,
  | "systemPromptFile"
  | "appendSystemPromptFile"
  | "memory"
  | "promptSections"
  | "instructionsAs"
  | "skillsMode"
  | "skillsInclude"
  | "skillsLoad"
  | "skillsSources"
>;

// chars 是修剪后的长度:composeSystemPrompt 修剪每段再以空行相接,所以各段长度加空行正好等于全文,
// 界面据此把系统提示词切回段(上下文面板的段开关)。
const meta = (s: PromptSection) => ({
  name: s.name,
  ...(s.source && { source: s.source }),
  chars: s.text.trim().length,
});

export function systemPromptFor(
  args: PromptArgs,
  cwd = process.cwd(),
  /** 发现目录的覆盖(测试用:临时的用户目录与仓库根)。 */
  discover?: DiscoverOptions,
): {
  text: string;
  sections: { name: string; source?: string; chars: number }[];
  /** 改放首条 user 消息的段(--instructions-as user)。 */
  preamble: { name: string; text: string }[];
} {
  const read = (p: string | undefined) => (p ? readFileSync(p, "utf8") : undefined);
  const replace = read(args.systemPromptFile);
  const append = read(args.appendSystemPromptFile);
  const built = buildSystemPrompt({
    base: BASE_PROMPT,
    cwd,
    ...(discover && { discover }),
    ...(replace !== undefined && { replace }),
    ...(append !== undefined && { append }),
    ...(args.promptSections && { sections: args.promptSections }),
    memory: args.memory ?? false,
    ...(args.instructionsAs && { instructionsAs: args.instructionsAs }),
    // prepareSessionRuntime 同样扫描技能,在那里只记一次完整诊断并上屏。
    onSkillError: () => {},
    skills: {
      ...(args.skillsMode && { mode: args.skillsMode }),
      ...(args.skillsInclude !== undefined && { include: args.skillsInclude }),
      ...(args.skillsLoad && { load: args.skillsLoad }),
      ...(args.skillsSources && { sources: args.skillsSources }),
    },
  });
  return {
    text: built.text,
    sections: built.sections.map(meta),
    preamble: built.preamble.map((s) => ({ name: s.name, text: s.text })),
  };
}

/**
 * 开始会话:新建时落 session/start(系统提示词与分段构成);恢复时沿用日志里的系统提示词,
 * 只在当前模型与日志最后记录的不同时追加 session/model。两个入口共用,界面层不再碰 session/start。
 */
export function beginSession(
  args: Pick<CommonArgs, "resume" | "continue"> & PromptArgs,
  choice: Pick<ModelChoice, "model">,
  cwd = process.cwd(),
  dir = SESSIONS_DIR,
): { log: EventLog; sessionFile: string; resumed: boolean } {
  const s = openSession(args, dir);
  if (!s.resumed) {
    const p = systemPromptFor(args, cwd);
    s.log.append({
      type: "session/start",
      at: now(),
      model: choice.model,
      system: p.text,
      sections: p.sections,
    });
    // instructionsAs = user:项目指令与记忆作为首条 user 消息进日志。
    // 它是一条用户没打过的用户消息,所以必须像其它用户消息一样落盘、上屏,不做任何隐藏。
    if (p.preamble.length > 0) {
      s.log.append({
        type: "user/message",
        at: now(),
        text: p.preamble.map((x) => x.text).join("\n\n"),
      });
    }
    return s;
  }
  const last = [...s.log.events]
    .reverse()
    .find((e) => e.type === "session/start" || e.type === "session/model");
  if (last && "model" in last && last.model !== choice.model) {
    s.log.append({ type: "session/model", at: now(), model: choice.model });
  }
  return s;
}
