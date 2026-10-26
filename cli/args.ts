import { type ApprovalConfig, DEFAULT_APPROVAL } from "../src/approval.js";
import { keepRatio, keepRecentTokens, type PreservationPolicy } from "../src/compaction.js";
import {
  DEFAULT_CONFIG_PATH,
  type KernelConfig,
  type Preset,
  type PromptSectionName,
  type ResultView,
  type ToolPromptStyle,
  type ToolPromptsConfig,
} from "../src/config.js";
import { COMPACTION_TRIGGERS, type CompactionTrigger, type ExecutionPolicy } from "../src/loop.js";
import { EFFORT_LEVELS, type EffortLevel, parseEffort } from "../src/provider.js";
import {
  parseSetting,
  parseSkillSources,
  SETTINGS,
  setSetting,
  settingDef,
} from "../src/settings.js";
import { isToolPromptStyle } from "./tool-prompts.js";

function parseRegisteredSetting(key: string, value: string): unknown {
  const def = settingDef(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  return parseSetting(def, value);
}

export const PROMPT_SECTION_NAMES: PromptSectionName[] = [
  "role",
  "env",
  "instructions",
  "memory",
  "skills",
  "append",
];

export type CommonArgs = {
  model?: string;
  effort?: EffortLevel;
  /** 内置名 llm | clear | pipeline,或一个导出 CompactionStrategy 的模块路径(.mjs/.js/.ts)。 */
  compaction: string;
  subagent: boolean;
  fold: boolean;
  /** 折叠时保留的结果行数(配置 foldLines)。 */
  foldLines?: number;
  /** 每个工具的结果可见度(配置 results)。 */
  results?: Record<string, ResultView>;
  /** 事实附注开关(配置 facts)。 */
  facts?: { repeats?: boolean; slow?: boolean; date?: boolean };
  /** plan 工具总开关(配置 plan)。 */
  plan?: boolean;
  /** 关掉的工具(配置 tools.disable)。 */
  disabledTools?: string[];
  /** 计划复述的步数(配置 planReminder)。 */
  planReminder?: number;
  /** 账簿保持展开的最新步数(配置 foldSteps)。 */
  foldSteps?: number;
  statusStyle?: Preset["statusStyle"];
  statusWidgets?: string[];
  showCostEstimate?: boolean;
  /** 屏幕模式(--screen / 配置 screen)。 */
  screen?: "alt" | "main";
  /** 桌面通知(--notify / 配置 notify)。 */
  notify?: "unfocused" | "always" | "off";
  checkUpdates?: boolean;
  /** 恢复指定会话文件。 */
  resume?: string;
  /** 恢复最近一次会话。 */
  continue: boolean;
  systemPromptFile?: string;
  appendSystemPromptFile?: string;
  maxSteps?: number;
  json: boolean;
  help: boolean;
  /** 审批槽:all(缺省)= 不问;policy = 按规则裁决,ask 的才问人;ask = 每个调用都问。 */
  approve: "all" | "ask" | "policy";
  /** 工具描述风格槽:命令行 > 预设 > 配置 > guided。 */
  toolPrompts?: ToolPromptStyle;
  /** 插话槽:step 缺省;turn = 留言等到模型停止调用工具。 */
  steering?: "step" | "turn";
  /** 保留策略:auto、"tokens N" 或 "ratio X";不给用内置缺省。 */
  preservation?: string;
  /** 压缩触发:threshold / manual / remind;不给用内置缺省 threshold。 */
  compactionTrigger?: CompactionTrigger;
  /** 自动压缩余量(token);不给用内置缺省 16384。 */
  compactionReserve?: number;
  /** 提早压缩的窗口比例;0 关闭,开启建议 0.8。 */
  compactionRatio?: number;
  compactionPrompt?: string;
  compactionMaxTokens?: number;
  compactionAcceptance?: NonNullable<Preset["compactionAcceptance"]>;
  /** 预设里的审批规则;没有就用配置的,再没有就用内置缺省。 */
  approval?: ApprovalConfig;
  /** 预设名:从配置 presets 取缺省参数;显式给的参数优先。 */
  preset?: string;
  /** 跨会话记忆:缺省关。 */
  memory?: boolean;
  /** 系统提示词的段与顺序。 */
  promptSections?: PromptSectionName[];
  /** 项目指令与记忆放 system 还是首条 user 消息。 */
  instructionsAs?: "system" | "user";
  /** 技能调用方式、自动范围与加载方式。 */
  skillsMode?: "manual" | "auto";
  skillsInclude?: "all" | string[];
  skillsLoad?: "read" | "tool";
  skillsSources?: Record<string, "on" | "off">;
  /** 执行槽:sequential 缺省;parallel = 并行安全的相邻只读调用同时跑。 */
  execution?: ExecutionPolicy;
  /** 扩展模块路径(可多个):default 导出一个函数,返回要加的工具与槽实现。 */
  extensions: string[];
  mcpReconnect?: string[];
  saveInputs?: boolean;
  /** 一次性模式:把每条事件以 JSON 行写到 stdout(事件流输出)。 */
  events: boolean;
  /** 非选项参数(一次性模式的任务文本)。 */
  rest: string[];
  /** 这几项有内置缺省值,记下是否显式给过,预设才知道能不能覆盖。 */
  compactionExplicit?: boolean;
  approveExplicit?: boolean;
  subagentExplicit?: boolean;
  foldExplicit?: boolean;
};

/** 给设置工作台一份解析后的启动快照,不把配置文件的后来变化当成运行中的值。 */
export function settingsFromArgs(args: CommonArgs): Preset {
  const values: Record<string, unknown> = {
    ...args,
    "tools.disable": args.disabledTools,
    "facts.repeats": args.facts?.repeats,
    "facts.slow": args.facts?.slow,
    "facts.date": args.facts?.date,
    "prompt.sections": args.promptSections,
    "prompt.instructionsAs": args.instructionsAs,
    "prompt.memory": args.memory,
    "prompt.skills.mode": args.skillsMode,
    "prompt.skills.include": args.skillsInclude,
    "prompt.skills.load": args.skillsLoad,
    "prompt.skills.sources": args.skillsSources,
  };
  let snapshot: Preset = {};
  for (const def of SETTINGS)
    snapshot = setSetting(snapshot, def.key, values[def.key] ?? def.builtin);
  return snapshot;
}

/** 保留策略的文字形态 → 实现与显示名:配置、预设、命令行、/preservation 共用一种写法。 */
export function parsePreservation(
  spec: string,
  window = Number.POSITIVE_INFINITY,
): { policy: PreservationPolicy; label: string } {
  if (spec === "auto")
    return {
      policy: keepRecentTokens(Math.min(20000, Math.floor(window / 4))),
      label: "Automatic token tail",
    };
  const m = spec.trim().match(/^(tokens|ratio)\s+([\d.]+)$/);
  if (!m) throw new Error(`preservation must be "auto", "tokens N" or "ratio X", got "${spec}"`);
  const n = Number(m[2]);
  if (!Number.isFinite(n)) throw new Error(`preservation ${m[1]} must be a finite number`);
  if (m[1] === "tokens") {
    if (!(n > 0)) throw new Error("preservation tokens must be positive");
    return { policy: keepRecentTokens(n), label: `keepRecentTokens(${n})` };
  }
  if (n <= 0 || n >= 1) throw new Error("preservation ratio must be between 0 and 1");
  return { policy: keepRatio(n), label: `keepRatio(${n})` };
}

/** 审批槽的启动形态:all / ask 原样;policy = 预设规则 → 配置规则 → 内置缺省。 */
export function resolveApproval(
  args: CommonArgs,
  config: KernelConfig,
): "all" | "ask" | ApprovalConfig {
  if (args.approve !== "policy") return args.approve;
  return args.approval ?? config.approval ?? DEFAULT_APPROVAL;
}

/** 工具描述风格的启动形态:风格按优先级取,逐工具覆盖只来自配置。 */
export function resolveToolPrompts(args: CommonArgs, config: KernelConfig): ToolPromptsConfig {
  return {
    style: args.toolPrompts ?? config.toolPrompts?.style ?? "explain",
    ...(config.toolPrompts?.descriptions && { descriptions: config.toolPrompts.descriptions }),
  };
}

export function isCompactionTrigger(v: string): v is CompactionTrigger {
  return (COMPACTION_TRIGGERS as string[]).includes(v);
}

export function parseCommonArgs(argv: string[]): CommonArgs {
  const out: CommonArgs = {
    compaction: "llm",
    subagent: false,
    fold: true,
    continue: false,
    json: false,
    help: false,
    approve: "all",
    extensions: [],
    events: false,
    rest: [],
  };
  const takeValue = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${name} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--model":
        out.model = takeValue(i++, a);
        break;
      case "--effort": {
        const v = takeValue(i++, a);
        const level = parseEffort(v);
        if (!level) {
          throw new Error(`unknown effort level "${v}"; choices: ${EFFORT_LEVELS.join(" ")}`);
        }
        out.effort = level;
        break;
      }
      case "--compaction":
        out.compaction = takeValue(i++, a);
        out.compactionExplicit = true;
        break;
      case "--resume":
        out.resume = takeValue(i++, a);
        break;
      case "--continue":
        out.continue = true;
        break;
      case "--system-prompt":
        out.systemPromptFile = takeValue(i++, a);
        break;
      case "--append-system-prompt":
        out.appendSystemPromptFile = takeValue(i++, a);
        break;
      case "--max-steps":
        out.maxSteps = Number(takeValue(i++, a));
        break;
      case "--subagent":
        out.subagent = true;
        out.subagentExplicit = true;
        break;
      case "--trace":
      case "--no-trace":
        throw new Error(
          "trace switches were removed; session request and response recording is always enabled",
        );
      case "--fold":
        out.fold = true;
        out.foldExplicit = true;
        break;
      case "--show-cost-estimate":
        out.showCostEstimate = true;
        break;
      case "--hide-cost-estimate":
        out.showCostEstimate = false;
        break;
      case "--check-updates":
        out.checkUpdates = true;
        break;
      case "--no-check-updates":
        out.checkUpdates = false;
        break;
      case "--screen": {
        const v = argv[++i];
        if (v !== "alt" && v !== "main") throw new Error("--screen takes alt or main");
        out.screen = v;
        break;
      }
      case "--notify": {
        const v = argv[++i];
        if (v !== "unfocused" && v !== "always" && v !== "off")
          throw new Error("--notify takes unfocused, always or off");
        out.notify = v;
        break;
      }
      case "--steering": {
        const v = takeValue(i++, a);
        if (v !== "step" && v !== "turn")
          throw new Error(`--steering accepts step or turn, got "${v}"`);
        out.steering = v;
        break;
      }
      case "--preservation": {
        const v = takeValue(i++, a);
        parsePreservation(v);
        out.preservation = v;
        break;
      }
      case "--compaction-trigger": {
        const v = takeValue(i++, a);
        if (!isCompactionTrigger(v))
          throw new Error(`--compaction-trigger accepts threshold, manual or remind, got "${v}"`);
        out.compactionTrigger = v;
        break;
      }
      case "--compaction-ratio": {
        out.compactionRatio = parseRegisteredSetting(
          "compactionRatio",
          takeValue(i++, a),
        ) as number;
        break;
      }
      case "--compaction-prompt":
        out.compactionPrompt = takeValue(i++, a);
        break;
      case "--compaction-max-tokens":
        out.compactionMaxTokens = parseRegisteredSetting(
          "compactionMaxTokens",
          takeValue(i++, a),
        ) as number;
        break;
      case "--compaction-acceptance":
        out.compactionAcceptance = parseRegisteredSetting(
          "compactionAcceptance",
          takeValue(i++, a),
        ) as NonNullable<Preset["compactionAcceptance"]>;
        break;
      case "--compaction-reserve": {
        const n = Number(takeValue(i++, a));
        if (!Number.isInteger(n) || n < 0)
          throw new Error("--compaction-reserve takes a non-negative integer number of tokens");
        out.compactionReserve = n;
        break;
      }
      case "--json":
        out.json = true;
        break;
      case "--approve": {
        const v = takeValue(i++, a);
        if (v !== "all" && v !== "ask" && v !== "policy")
          throw new Error(`--approve accepts all, ask or policy, got "${v}"`);
        out.approve = v;
        out.approveExplicit = true;
        break;
      }
      case "--tool-prompts": {
        const v = takeValue(i++, a);
        if (!isToolPromptStyle(v))
          throw new Error(`--tool-prompts accepts brief, explain or rules, got "${v}"`);
        out.toolPrompts = v;
        break;
      }
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--preset":
        out.preset = takeValue(i++, a);
        break;
      case "--memory":
        out.memory = true;
        break;
      case "--no-memory":
        out.memory = false;
        break;
      case "--prompt-sections": {
        const v = takeValue(i++, a);
        const names = v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        for (const n of names) {
          if (!PROMPT_SECTION_NAMES.includes(n as PromptSectionName)) {
            throw new Error(
              `unknown prompt section "${n}"; choices: ${PROMPT_SECTION_NAMES.join(" ")}`,
            );
          }
        }
        out.promptSections = names as PromptSectionName[];
        break;
      }
      case "--instructions-as": {
        const v = takeValue(i++, a);
        if (v !== "system" && v !== "user")
          throw new Error("--instructions-as accepts system or user");
        out.instructionsAs = v;
        break;
      }
      case "--execution": {
        const v = takeValue(i++, a);
        if (v !== "sequential" && v !== "parallel")
          throw new Error(`--execution accepts sequential or parallel, got "${v}"`);
        out.execution = v;
        break;
      }
      case "--extension":
        out.extensions.push(takeValue(i++, a));
        break;
      case "--mcp-reconnect":
        out.mcpReconnect = takeValue(i++, a)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--save-inputs":
        out.saveInputs = true;
        break;
      case "--no-save-inputs":
        out.saveInputs = false;
        break;
      case "--events":
        out.events = true;
        break;
      case "-p":
      case "--prompt":
        out.rest.push(takeValue(i++, a));
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        out.rest.push(a);
    }
  }
  return out;
}

export const USAGE = `Usage
  clarook [options]                      interactive UI          (from source: pnpm tui -- [options])
  clarook once "task" [options]          one-shot mode: run one turn and exit; stdout is the reply
  clarook replay <session.jsonl> [--request N] [--compaction N [--json]] [--messages]

Options
  --model provider/model         default: the config's default model
  --effort off|low|medium|high|xhigh|max   default: not sent, provider default applies
  --compaction llm|clear|pipeline|./strategy.mjs   default llm
  --resume <session file> | --continue   resume a session and keep appending to the same file
  --system-prompt <file> | --append-system-prompt <file>
  --approve all|policy|ask       all (default) = never ask; policy = allow/deny rules from config, ask when no rule matches; ask = every call
  --tool-prompts brief|explain|rules   tool description level (default explain); edit single descriptions with /toolprompts edit <tool>
  --preset name                  apply the parameter set presets.name from config; explicit flags still win
  --memory | --no-memory         cross-session memory (memory section in AGENTS.md + remember tool); default off
  --prompt-sections role,env,instructions,memory,skills,append   which system prompt sections, in which order
  --instructions-as system|user  put project instructions and memory in system (default) or in the first user message
  --execution sequential|parallel  tool execution slot: default one at a time; parallel = adjacent read-only calls run together
  --steering step|turn           steering slot: step (default) injects queued messages at the next step; turn waits until the model stops calling tools
  --preservation "auto|tokens N|ratio X"   recent history kept verbatim; default tokens 20000
  --compaction-trigger threshold|manual|remind   threshold (default) compacts when usage passes window - reserve; manual only on /compact; remind only shows a hint
  --compaction-reserve N         tokens kept free below the window (default 16384)
  --compaction-ratio X           early compaction by window fraction; 0 off, 0.8 suggested; reserve may trigger earlier
  --compaction-prompt name|file.md   summary template: pi (default), codex, zcode, opencode, clarook-detailed, minimal
  --compaction-max-tokens N      summary output limit (default 13107); 0 uses provider configuration
  --compaction-acceptance complete|smaller|reduced   apply complete summaries (default), or require size reduction
  --extension <module.mjs>       load an extension module (repeatable): add tools, replace slot implementations
  --max-steps N                  termination guard (default: no limit)
  --subagent                     add the task tool (sub-agents)
  --no-save-inputs               disable local draft and pending-input saving (default: on)
  --fold                         tool results start folded (the default; config fold: false starts unfolded; Ctrl+O toggles)
  --show-cost-estimate           show a token-based estimate, not the provider bill (default: off)
  --screen alt|main              alt (default): fixed header and status, own scrolling, mouse, search; main keeps the terminal scrollback
  --notify unfocused|always|off  desktop notification when a turn ends or approval is needed (default: only while the terminal is unfocused)
  --check-updates | --no-check-updates  check for a newer release at TUI startup (default: on); never installs automatically
  --json                         one-shot mode: print a structured result
  --events                       one-shot mode: write every event to stdout as a JSON line
  -h, --help

Config
  ${DEFAULT_CONFIG_PATH}
  CLAROOK_CONFIG overrides the path; keys come from the env var named by apiKeyEnv, or /login in the UI
  every option above has a config counterpart: defaults.<name> is the global default, presets.<name>.<option> a named set; flags > preset > defaults > built-in
  clarook sessions [--dir D]        list session files; clarook sessions prune --older-than 30d | --keep N [--yes]
  session files default to ./sessions/; override with sessionsDir in config or CLAROOK_SESSIONS
  prompt templates: ~/.clarook/prompts/*.md and <git root>/.clarook/prompts/*.md; /name args in the UI
  skills (first name wins): ~/.clarook/skills, ~/.claude/skills, <git root>/.agents/skills, <git root>/.claude/skills
  each location loads direct <name>/SKILL.md; invoke with /name args (manual by default); /inspect skills shows sources
  automatic skills: enable in /settings; selected catalogs go in the system prompt (read mode) or the skill tool definition (tool mode)`;

export function applyPreset(args: CommonArgs, config: KernelConfig): CommonArgs {
  const out: CommonArgs = { ...args };
  const preset = args.preset ? config.presets?.[args.preset] : undefined;
  if (args.preset && !preset) {
    throw new Error(
      `no preset "${args.preset}" in config; choices: ${Object.keys(config.presets ?? {}).join(" ") || "(none)"}`,
    );
  }
  // 解析顺序:命令行 > 预设 > 配置 defaults > 内置缺省。有内置缺省的字段靠 *Explicit 与 settled 判断"还没人定"。
  const settled = new Set<string>();
  const open = (field: string, explicit: boolean | undefined) => !explicit && !settled.has(field);
  const applyLayer = (layer: Preset, label: string) => {
    if (out.model === undefined && !settled.has("model") && layer.model !== undefined) {
      if (layer.model !== null) out.model = layer.model;
      settled.add("model");
    }
    if (out.effort === undefined && !settled.has("effort") && layer.effort !== undefined) {
      settled.add("effort");
      if (layer.effort !== null) {
        const level = parseEffort(layer.effort);
        if (!level) throw new Error(`${label} has invalid effort "${layer.effort}"`);
        out.effort = level;
      }
    }
    if (open("compaction", args.compactionExplicit) && layer.compaction) {
      out.compaction = layer.compaction;
      settled.add("compaction");
    }
    if (open("approve", args.approveExplicit) && layer.approve) {
      out.approve = layer.approve;
      settled.add("approve");
    }
    if (open("subagent", args.subagentExplicit) && layer.subagent !== undefined) {
      out.subagent = layer.subagent;
      settled.add("subagent");
    }
    if (open("fold", args.foldExplicit) && layer.fold !== undefined) {
      out.fold = layer.fold;
      settled.add("fold");
    }
    if (out.foldLines === undefined && layer.foldLines !== undefined)
      out.foldLines = layer.foldLines;
    if (out.results === undefined && layer.results !== undefined) out.results = layer.results;
    if (out.facts === undefined && layer.facts !== undefined) out.facts = layer.facts;
    if (out.plan === undefined && layer.plan !== undefined) out.plan = layer.plan;
    if (out.disabledTools === undefined && layer.tools?.disable)
      out.disabledTools = layer.tools.disable;
    if (out.mcpReconnect === undefined && layer.mcpReconnect !== undefined)
      out.mcpReconnect = [...layer.mcpReconnect];
    if (out.saveInputs === undefined && layer.saveInputs !== undefined)
      out.saveInputs = layer.saveInputs;
    if (out.planReminder === undefined && layer.planReminder !== undefined)
      out.planReminder = layer.planReminder;
    if (out.foldSteps === undefined && layer.foldSteps !== undefined)
      out.foldSteps = layer.foldSteps;
    if (out.statusStyle === undefined && layer.statusStyle !== undefined)
      out.statusStyle = layer.statusStyle;
    if (out.statusWidgets === undefined && layer.statusWidgets !== undefined)
      out.statusWidgets = [...layer.statusWidgets];
    if (out.showCostEstimate === undefined && layer.showCostEstimate !== undefined)
      out.showCostEstimate = layer.showCostEstimate;
    if (out.screen === undefined && layer.screen !== undefined) out.screen = layer.screen;
    if (out.notify === undefined && layer.notify !== undefined) out.notify = layer.notify;
    if (out.checkUpdates === undefined && layer.checkUpdates !== undefined)
      out.checkUpdates = layer.checkUpdates;
    if (out.toolPrompts === undefined && layer.toolPrompts) out.toolPrompts = layer.toolPrompts;
    if (out.approval === undefined && layer.approval) out.approval = layer.approval;
    if (out.systemPromptFile === undefined && layer.systemPromptFile)
      out.systemPromptFile = layer.systemPromptFile;
    if (out.appendSystemPromptFile === undefined && layer.appendSystemPromptFile)
      out.appendSystemPromptFile = layer.appendSystemPromptFile;
    if (out.maxSteps === undefined && !settled.has("maxSteps") && layer.maxSteps !== undefined) {
      if (layer.maxSteps !== null) out.maxSteps = layer.maxSteps;
      settled.add("maxSteps");
    }
    if (out.execution === undefined && layer.execution) out.execution = layer.execution;
    if (out.steering === undefined && layer.steering) out.steering = layer.steering;
    if (
      out.preservation === undefined &&
      !settled.has("preservation") &&
      layer.preservation !== undefined
    ) {
      settled.add("preservation");
      if (layer.preservation !== null) {
        parsePreservation(layer.preservation);
        out.preservation = layer.preservation;
      }
    }
    if (out.compactionTrigger === undefined && layer.compactionTrigger)
      out.compactionTrigger = layer.compactionTrigger;
    if (out.compactionReserve === undefined && layer.compactionReserve !== undefined)
      out.compactionReserve = layer.compactionReserve;
    if (out.compactionRatio === undefined && layer.compactionRatio !== undefined)
      out.compactionRatio = parseRegisteredSetting(
        "compactionRatio",
        String(layer.compactionRatio),
      ) as number;
    if (out.compactionPrompt === undefined && layer.compactionPrompt !== undefined)
      out.compactionPrompt = parseRegisteredSetting(
        "compactionPrompt",
        layer.compactionPrompt,
      ) as string;
    if (out.compactionMaxTokens === undefined && layer.compactionMaxTokens !== undefined)
      out.compactionMaxTokens = parseRegisteredSetting(
        "compactionMaxTokens",
        String(layer.compactionMaxTokens),
      ) as number;
    if (out.compactionAcceptance === undefined && layer.compactionAcceptance !== undefined)
      out.compactionAcceptance = parseRegisteredSetting(
        "compactionAcceptance",
        layer.compactionAcceptance,
      ) as NonNullable<Preset["compactionAcceptance"]>;
    if (out.extensions.length === 0 && layer.extensions) out.extensions = [...layer.extensions];
  };
  if (preset) applyLayer(preset, `preset ${args.preset}`);
  if (config.defaults) applyLayer(config.defaults, "config defaults");
  // prompt 段的三层同样按 预设 > defaults > 配置顶层 prompt 合并;命令行给了的字段不动。
  const prompt = { ...config.prompt, ...config.defaults?.prompt, ...preset?.prompt };
  if (out.memory === undefined && prompt.memory !== undefined) out.memory = prompt.memory;
  if (out.promptSections === undefined && prompt.sections) out.promptSections = prompt.sections;
  if (out.instructionsAs === undefined && prompt.instructionsAs) {
    out.instructionsAs = prompt.instructionsAs;
  }
  const skills = {
    ...config.prompt?.skills,
    ...config.defaults?.prompt?.skills,
    ...preset?.prompt?.skills,
  };
  if ("list" in skills)
    throw new Error("prompt.skills.list was removed; use prompt.skills.mode: manual or auto.");
  if (skills.mode) out.skillsMode = skills.mode;
  if (skills.include !== undefined) out.skillsInclude = skills.include;
  if (skills.load) out.skillsLoad = skills.load;
  if (skills.sources !== undefined) out.skillsSources = parseSkillSources(skills.sources);
  return out;
}
