// 内核与工具的低分支(重构块 7):配置文件的每种坏形态与写回、模型解析的猜测与报错、key 的三条路;
// bash 的 shell 不可用 / 打断 / 非零退出 / 截断落盘;搜索结果上限;参数解析的每个开关。

import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPreset, parseCommonArgs, resolveApproval } from "../cli/args.js";
import { createBashTool } from "../cli/tools/bash.js";
import { createGrepTool, globTool } from "../cli/tools/search.js";
import { keepTail } from "../cli/tools/truncate.js";
import { DEFAULT_APPROVAL } from "../src/approval.js";
import {
  CONFIG_TEMPLATE,
  createProvider,
  findApiKey,
  type KernelConfig,
  loadConfig,
  loadCredentials,
  resolveApiKey,
  resolveModel,
  saveCredential,
  setApiKey,
  setDefaultModel,
  updateConfig,
} from "../src/config.js";

const ctx = (signal = new AbortController().signal) => ({ signal }) as never;

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  delete process.env.CLAROOK_SHELL;
});

const base: KernelConfig = {
  default: "m",
  providers: {
    fake: { protocol: "openai", baseUrl: "http://x/v1", apiKeyEnv: "FAKE_KEY", models: ["m"] },
  },
};

describe("配置文件", () => {
  it("不存在就写模板并标 created;再读不标;坏 JSON 报路径;四种缺字段各自报错", () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-cfg-"));
    const path = join(tmp, "deep", "config.json");
    const first = loadConfig(path);
    expect(first.created).toBe(true);
    expect(first.config.default).toBe(CONFIG_TEMPLATE.default);
    expect(existsSync(path)).toBe(true);
    expect(loadConfig(path).created).toBe(false);
    writeFileSync(path, "{ not json");
    expect(() => loadConfig(path)).toThrow(/failed to parse config .*config\.json/);
    const bad = (obj: unknown, message: RegExp) => {
      writeFileSync(path, JSON.stringify(obj));
      expect(() => loadConfig(path)).toThrow(message);
    };
    bad({ providers: {} }, /missing default or providers/);
    bad({ default: "m" }, /missing default or providers/);
    bad(
      { default: "m", providers: { p: { protocol: "grpc", baseUrl: "x", models: [] } } },
      /protocol must be/,
    );
    bad(
      { default: "m", providers: { p: { protocol: "openai", models: [] } } },
      /missing baseUrl or models/,
    );
    bad(
      { default: "m", providers: { p: { protocol: "openai", baseUrl: "x", models: [42] } } },
      /models entries/,
    );
  });

  it("setApiKey 写进凭据文件并去空白,配置不动,未知供应商报错列出选项;setDefaultModel 写回配置", () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-cfg-"));
    const path = join(tmp, "config.json");
    const creds = join(tmp, "credentials.json");
    expect(() => setApiKey(base, "nope", "k", creds)).toThrow(
      /unknown provider "nope"; options: fake/,
    );
    const next = setApiKey(base, "fake", "  sk-1  ", creds);
    expect(next).toBe(base);
    expect(JSON.parse(readFileSync(creds, "utf8")).fake.apiKey).toBe("sk-1");
    expect(loadCredentials(creds).fake?.apiKey).toBe("sk-1");
    saveCredential("other", "sk-2", creds);
    expect(Object.keys(loadCredentials(creds))).toEqual(["fake", "other"]);
    writeFileSync(creds, `\uFEFF${readFileSync(creds, "utf8")}`);
    expect(Object.keys(loadCredentials(creds))).toEqual(["fake", "other"]);
    saveCredential("third", "local-fixture", creds);
    expect(Object.keys(loadCredentials(creds))).toEqual(["fake", "other", "third"]);
    writeFileSync(creds, "not-json-local-private-fixture");
    expect(() => loadCredentials(creds)).toThrow(/failed to parse credentials/);
    try {
      loadCredentials(creds);
    } catch (error) {
      expect(String(error)).not.toContain("local-private-fixture");
    }
    writeFileSync(path, JSON.stringify(next));
    writeFileSync(path, `\uFEFF${readFileSync(path, "utf8")}`);
    expect(loadConfig(path).config.default).toBe(next.default);
    const withDefault = setDefaultModel("fake/other", path);
    expect(withDefault.default).toBe("fake/other");
    expect(JSON.parse(readFileSync(path, "utf8")).default).toBe("fake/other");
    const saveFromChild = () =>
      childProcess.spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { updateConfig } from './src/config.ts';
       updateConfig(c => ({...c, defaults:{...c.defaults, execution:'parallel'}}), process.argv[1]);`,
          path,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
    updateConfig((current) => {
      const busy = saveFromChild();
      expect(busy.status).not.toBe(0);
      expect(busy.stderr).toContain("File is in use");
      expect(loadConfig(path).config.default).toBe("fake/other");
      return { ...current, defaults: { ...current.defaults, steering: "turn" } };
    }, path);
    const child = saveFromChild();
    expect(child.status, child.stderr).toBe(0);
    expect(loadConfig(path).config.defaults).toMatchObject({
      steering: "turn",
      execution: "parallel",
    });
    const saved = readFileSync(path, "utf8");
    expect(() =>
      updateConfig(() => {
        throw new Error("cancel save");
      }, path),
    ).toThrow("cancel save");
    expect(readFileSync(path, "utf8")).toBe(saved);
  });
});

describe("模型解析与 key", () => {
  const cfg: KernelConfig = {
    default: "deepseek-v4-pro",
    providers: {
      deepseek: {
        protocol: "openai",
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-v4-pro"],
        extraBody: { a: 1 },
        contextWindow: 100,
      },
      anthropic: {
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        models: [
          { name: "claude-x", maxTokens: 5, price: { input: 1, output: 2 }, extraBody: { b: 2 } },
        ],
        thinkingMode: "adaptive",
        promptCache: false,
        stallTimeoutMs: 0,
        retry: { maxRetries: 1 },
        extraHeaders: { "x-h": "1" },
      },
      openai: {
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [],
        reasoningSummary: "auto",
      },
    },
  };

  it("显式 供应商/模型;未知供应商报错;按前缀猜到 anthropic / deepseek / openai;猜不到列出全部", () => {
    expect(resolveModel(cfg, "anthropic/claude-y").model).toBe("claude-y");
    expect(() => resolveModel(cfg, "nope/x")).toThrow(/unknown provider "nope"/);
    expect(resolveModel(cfg, "claude-z").providerName).toBe("anthropic");
    expect(resolveModel(cfg, "deepseek-new").providerName).toBe("deepseek");
    expect(resolveModel(cfg, "gpt-9").providerName).toBe("openai");
    expect(resolveModel(cfg, "o5-mini").providerName).toBe("openai");
    expect(() => resolveModel(cfg, "llama")).toThrow(
      /no provider matches model "llama"[\s\S]*deepseek\/deepseek-v4-pro/,
    );
  });

  it("finish 合并:模型级 maxTokens / price / extraBody 与供应商级 extraBody、thinkingMode;窗口回落 128000", () => {
    const r = resolveModel(cfg, "anthropic/claude-x");
    expect(r).toMatchObject({
      maxTokens: 5,
      price: { input: 1, output: 2 },
      extraBody: { b: 2 },
      thinkingMode: "adaptive",
      contextWindow: 128000,
    });
    expect(resolveModel(cfg, "deepseek-v4-pro")).toMatchObject({
      extraBody: { a: 1 },
      contextWindow: 100,
    });
    expect(resolveModel(cfg, "openai/gpt-9").extraBody).toBeUndefined();
  });

  it("key:环境变量 > 凭据文件 > 配置字段,都去空白;缺失时的提示指向 /login、环境变量与凭据文件", () => {
    const p = cfg.providers.deepseek as NonNullable<KernelConfig["providers"]["x"]>;
    tmp = mkdtempSync(join(tmpdir(), "clarook-cred-"));
    const creds = join(tmp, "credentials.json");
    const env = { CLAROOK_CREDENTIALS: creds };
    expect(resolveApiKey("deepseek", { ...p, apiKey: " k1 " }, env)).toBe("k1");
    saveCredential("deepseek", " k3 ", creds);
    expect(findApiKey("deepseek", { ...p, apiKey: "k1" }, env)).toEqual({
      key: "k3",
      source: "credentials",
    });
    expect(resolveApiKey("deepseek", { ...p, apiKeyEnv: "K" }, { ...env, K: " k2 " })).toBe("k2");
    const none = { CLAROOK_CREDENTIALS: join(tmp, "none.json") };
    expect(findApiKey("deepseek", p, none)).toBeUndefined();
    expect(() => resolveApiKey("deepseek", { ...p, apiKeyEnv: "K" }, none)).toThrow(
      /Run \/login in the TUI, set env var K, or add it to .*none\.json/,
    );
    expect(() => resolveApiKey("deepseek", p, none)).toThrow(
      /Run \/login in the TUI, or add it to/,
    );
  });

  it("createProvider:三种协议各自带上供应商级选项;手工 Resolved 回落到供应商字段", () => {
    const a = createProvider(resolveModel(cfg, "anthropic/claude-x"), "k");
    expect(a.model).toBe("claude-x");
    expect(a.fields?.protocol.startsWith("anthropic")).toBe(true);
    const o = createProvider(resolveModel(cfg, "openai/gpt-9"), "k");
    expect(o.fields?.protocol).toContain("responses");
    const d = createProvider(
      {
        providerName: "deepseek",
        provider: cfg.providers.deepseek as never,
        model: "x",
        contextWindow: 1,
      },
      "k",
    );
    expect(d.model).toBe("x");
    expect(d.fields?.protocol.startsWith("openai")).toBe(true);
  });
});

describe("bash 工具的其它边界", () => {
  it("CLAROOK_SHELL 指向不存在的程序 → 启动失败报错;非零退出带输出;无输出说明;截断落盘", async () => {
    process.env.CLAROOK_SHELL = join(tmpdir(), "no-such-shell-xyz.exe");
    const broken = createBashTool();
    await expect(broken.execute({ command: "echo hi" }, ctx())).rejects.toThrow();
    delete process.env.CLAROOK_SHELL;
    const tool = createBashTool({ truncate: keepTail({ maxLines: 3 }) });
    await expect(tool.execute({ command: "echo out; exit 3" }, ctx())).rejects.toThrow(
      /out[\s\S]*exited with code 3/,
    );
    expect(await tool.execute({ command: "true" }, ctx())).toBe("(no output)");
    const spilled = await tool.execute({ command: "printf 'a\\nb\\nc\\nd\\n'" }, ctx());
    expect(spilled).toContain("c\nd");
    expect(spilled).not.toContain("a\nb");
    const file = spilled.match(/Full output: (.+)\]/)?.[1];
    expect(file && readFileSync(file, "utf8")).toBe("a\nb\nc\nd\n");
    const large = await tool.execute(
      { command: "yes X | head -c 70000; printf '\\nDIRECT_END\\n'" },
      ctx(),
    );
    const largeFile = large.match(/Full output: (.+)\]/)?.[1];
    expect(large).toContain("DIRECT_END");
    expect(largeFile && readFileSync(largeFile, "utf8")).toContain("DIRECT_END");
    expect(largeFile && readFileSync(largeFile).length).toBeGreaterThan(70000);
    if (file) rmSync(dirname(file), { recursive: true, force: true });
    if (largeFile) rmSync(dirname(largeFile), { recursive: true, force: true });
    expect(await tool.execute({ command: "echo unlimited", timeout: 0 }, ctx())).toBe("unlimited");
  }, 20000);

  it("打断:请求停止不依赖 PATH,及时结束本地等待并保留已产出的输出", async () => {
    const tool = createBashTool();
    const already = new AbortController();
    already.abort();
    await expect(
      tool.execute({ command: "echo should-not-run" }, ctx(already.signal)),
    ).rejects.toThrow(/interrupted|aborted/);
    const ac = new AbortController();
    const started = Date.now();
    const pending = tool.execute({ command: "echo started; sleep 5; echo late" }, ctx(ac.signal));
    setTimeout(() => {
      const originalPath = process.env.PATH;
      try {
        if (process.platform === "win32") process.env.PATH = "";
        ac.abort();
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    }, 300);
    const failure = await pending.then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/command interrupted[\s\S]*started/);
    expect(failure?.message).not.toContain("could not stop process tree");
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20000);
});

describe("搜索工具的上限", () => {
  it("grep 的结果上限按整次搜索计算,文件路径可直接复用", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-search-"));
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "a.ts"), "Needle here\nneedle again");
    const grep = createGrepTool({ maxResults: 1 });
    const capped = await grep.execute({ pattern: "needle", path: tmp, ignoreCase: true }, ctx());
    expect(capped).toContain("a.ts:1:Needle here");
    expect(capped).toContain("showing first 1 results");
    expect(capped).not.toContain("needle again");
    const inFile = await grep.execute({ pattern: "again", path: join(tmp, "src", "a.ts") }, ctx());
    expect(inFile).toContain(":2:needle again");
  });

  it("glob 工具:无匹配说明;超过 500 条截断", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-glob-"));
    for (let i = 0; i < 501; i++) writeFileSync(join(tmp, `f${i}.txt`), "");
    expect(await globTool.execute({ pattern: "*.md", path: tmp }, ctx())).toBe("(no matches)");
    let recorded = "";
    const out = await globTool.execute({ pattern: "*.txt", path: tmp }, {
      signal: new AbortController().signal,
      output: {
        path: "saved-list.body",
        ref: { file: "saved-list.body", label: "glob" },
        write: (text: string | Uint8Array) => {
          recorded += text;
        },
      },
    } as Parameters<typeof globTool.execute>[1]);
    expect(out).toContain(
      "[showing first 500 of 501 scanned matches; recorded 501 scanned matches: saved-list.body]",
    );
    expect(out.split("\n")).toHaveLength(501);
    expect(out).not.toContain("f99.txt");
    expect(recorded).toContain("f99.txt");
  });
});

describe("参数解析的每个开关", () => {
  it("每个选项落到字段;非法值各自报错;-h", () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-args-"));
    const a = parseCommonArgs([
      "--resume",
      "s.jsonl",
      "--system-prompt",
      "sys.md",
      "--append-system-prompt",
      "more.md",
      "--subagent",
      "--fold",
      "--steering",
      "turn",
      "--preservation",
      "ratio 0.2",
      "--approve",
      "ask",
      "--tool-prompts",
      "brief",
      "--preset",
      "fast",
      "--memory",
      "--prompt-sections",
      "role, env",
      "--instructions-as",
      "user",
      "--execution",
      "parallel",
      "--extension",
      "a.mjs",
      "--extension",
      "b.mjs",
      "--events",
      "-h",
    ]);
    expect(a).toMatchObject({
      resume: "s.jsonl",
      systemPromptFile: "sys.md",
      appendSystemPromptFile: "more.md",
      subagent: true,
      subagentExplicit: true,

      fold: true,
      foldExplicit: true,
      steering: "turn",
      preservation: "ratio 0.2",
      approve: "ask",
      approveExplicit: true,
      toolPrompts: "brief",
      preset: "fast",
      memory: true,
      promptSections: ["role", "env"],
      instructionsAs: "user",
      execution: "parallel",
      extensions: ["a.mjs", "b.mjs"],
      events: true,
      help: true,
    });
    expect(parseCommonArgs(["--no-memory"]).memory).toBe(false);
    expect(() => parseCommonArgs(["--prompt-sections", "role,bogus"])).toThrow(
      /unknown prompt section "bogus"/,
    );
    expect(() => parseCommonArgs(["--instructions-as", "sideways"])).toThrow(
      /accepts system or user/,
    );
    expect(() => parseCommonArgs(["--execution", "fast"])).toThrow(
      /accepts sequential or parallel/,
    );
    expect(() => parseCommonArgs(["--approve", "maybe"])).toThrow(/accepts all, ask or policy/);
    expect(() => parseCommonArgs(["--preservation", "ratio 9"])).toThrow(/between 0 and 1/);
    expect(() => parseCommonArgs(["--preservation", "tokens 0"])).toThrow(/must be positive/);
  });

  it("applyPreset:未知预设、非法 effort 报错;预设的文件、扩展、maxSteps、审批规则、prompt.sections 都套上;resolveApproval 三级回落", () => {
    const config: KernelConfig = {
      ...base,
      prompt: { sections: ["role", "env"] },
      approval: { default: "ask", allow: ["read"] },
      presets: {
        p: {
          effort: "high",
          systemPromptFile: "sys.md",
          appendSystemPromptFile: "add.md",
          extensions: ["x.mjs"],
          maxSteps: 3,
          approval: { default: "allow" },
          subagent: true,
        },
        bad: { effort: "ultra" },
      },
    };
    expect(() => applyPreset(parseCommonArgs(["--preset", "nope"]), config)).toThrow(
      /no preset "nope" in config; choices: p bad/,
    );
    expect(() => applyPreset(parseCommonArgs(["--preset", "bad"]), config)).toThrow(
      /invalid effort "ultra"/,
    );
    const out = applyPreset(parseCommonArgs(["--preset", "p"]), config);
    expect(out).toMatchObject({
      effort: "high",
      systemPromptFile: "sys.md",
      appendSystemPromptFile: "add.md",
      extensions: ["x.mjs"],
      maxSteps: 3,
      approval: { default: "allow" },
      subagent: true,
      promptSections: ["role", "env"],
    });
    expect(resolveApproval(parseCommonArgs(["--approve", "ask"]), config)).toBe("ask");
    expect(resolveApproval({ ...out, approve: "policy" }, config)).toEqual({ default: "allow" });
    expect(resolveApproval(parseCommonArgs(["--approve", "policy"]), config)).toEqual({
      default: "ask",
      allow: ["read"],
    });
    expect(resolveApproval(parseCommonArgs(["--approve", "policy"]), base)).toBe(DEFAULT_APPROVAL);
  });
});
