// 模型登记簿:能力数据的顺序(模型配置 > models.dev > 供应商配置 > 假设)、三级推导、缓存与超时、内置快照、
// 行注与出处;登录对话框里服务器多出来的模型可选并写进配置。
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSUMED_CONTEXT,
  capabilityNote,
  closestConfigured,
  describeCapabilities,
  describeInferred,
  fetchRegistry,
  inferModelConfig,
  loadRegistrySync,
  lookupModel,
  type Registry,
  registryProviderId,
  resolveCapabilities,
  SNAPSHOT,
} from "../cli/registry.js";
import { type LoginDeps, LoginDialog } from "../cli/tui-login.js";
import { checkForUpdate, installedVersion } from "../cli/update-check.js";
import {
  addModel,
  CONFIG_TEMPLATE,
  type KernelConfig,
  type ProviderConfig,
} from "../src/config.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { testDirectory } from "./helpers/setup.js";
import { stripAnsi } from "./helpers/virtual-terminal.js";

const REG: Registry = {
  deepseek: {
    id: "deepseek",
    models: {
      "deepseek-v4-flash-vision-exp": {
        id: "deepseek-v4-flash-vision-exp",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        limit: { context: 1_000_000, output: 384_000 },
        cost: { input: 0.098, output: 0.196, cache_read: 0.028 },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        limit: { context: 1_000_000, output: 384_000 },
        cost: { input: 1, output: 2 },
      },
    },
  },
  other: { models: { "some-model": { id: "some-model", limit: { context: 32000 } } } },
};

const DS: ProviderConfig = {
  protocol: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [
    { name: "deepseek-v4-pro", contextWindow: 131072, price: { input: 1, output: 2 } },
    { name: "deepseek-v4-flash", effortLevels: ["low", "high"] },
  ],
};

describe("启动版本检查", () => {
  it("读取本机包版本,按语义版本比较;只返回可确认的新稳定版本", async () => {
    expect(installedVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    const check = (data: unknown, currentVersion = "0.1.2") =>
      checkForUpdate({
        currentVersion,
        fetchImpl: async () => Response.json(data),
      });
    expect(await check({ version: "0.1.10" })).toEqual({ current: "0.1.2", latest: "0.1.10" });
    for (const data of [
      { version: "0.1.2" },
      { version: "0.1.1" },
      { version: "0.2.0-beta.1" },
      { version: "not a version" },
      {},
      null,
    ])
      expect(await check(data)).toBeUndefined();
  });

  it("网络失败、非成功响应、超时和主动取消均结束检查;不重试", async () => {
    let calls = 0;
    expect(
      await checkForUpdate({
        currentVersion: "0.1.0",
        fetchImpl: async () => {
          calls++;
          throw new Error("offline");
        },
      }),
    ).toBeUndefined();
    expect(calls).toBe(1);
    expect(
      await checkForUpdate({
        currentVersion: "0.1.0",
        fetchImpl: async () => new Response("rate limited", { status: 429 }),
      }),
    ).toBeUndefined();
    const waiting: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    expect(
      await checkForUpdate({ currentVersion: "0.1.0", timeoutMs: 5, fetchImpl: waiting }),
    ).toBeUndefined();
    const abort = new AbortController();
    const pending = checkForUpdate({
      currentVersion: "0.1.0",
      signal: abort.signal,
      fetchImpl: waiting,
    });
    abort.abort();
    expect(await pending).toBeUndefined();
  });
});

describe("能力数据的顺序", () => {
  it("模型配置明写的压过登记簿;没写的项从登记簿取;登记簿也没有的回落到供应商级,再没有就假设", () => {
    // pro:窗口配置明写 131072(config),价格配置明写;输出上限配置没写 → 登记簿 384k
    const pro = resolveCapabilities("deepseek", DS, "deepseek-v4-pro", REG);
    expect(pro).toMatchObject({ contextWindow: 131072, source: "config", maxTokens: 384_000 });
    expect(pro.priceSource).toBe("config");
    // flash:登记簿没有这个 id → 供应商级也没有 → 假设;强度档来自配置
    const flash = resolveCapabilities("deepseek", DS, "deepseek-v4-flash", REG);
    expect(flash).toEqual({
      contextWindow: ASSUMED_CONTEXT,
      source: "assumed",
      effortLevels: ["low", "high"],
    });
    // vision-exp:配置里没有 → 全部来自登记簿
    const withIt: ProviderConfig = {
      ...DS,
      models: [...DS.models, "deepseek-v4-flash-vision-exp"],
    };
    const vis = resolveCapabilities("deepseek", withIt, "deepseek-v4-flash-vision-exp", REG);
    expect(vis).toEqual({
      contextWindow: 1_000_000,
      source: "models.dev",
      maxTokens: 384_000,
      effortLevels: ["off", "low", "high", "max"],
      price: { input: 0.098, output: 0.196, cacheRead: 0.028 },
      priceSource: "models.dev",
    });
    const provider = openaiCompat({
      baseUrl: withIt.baseUrl,
      apiKey: "local-fixture",
      model: "deepseek-v4-flash-vision-exp",
      dialect: "deepseek",
      ...(vis.effortLevels && { effortLevels: vis.effortLevels }),
    });
    expect(provider.wire?.([], [], { effort: "off" })).toMatchObject({
      thinking: { type: "disabled" },
    });
    const model = lookupModel(REG, "deepseek", "deepseek-v4-flash-vision-exp");
    if (!model) throw new Error("Missing registry fixture");
    const noToggle: Registry = {
      deepseek: {
        models: {
          "deepseek-v4-flash-vision-exp": {
            ...model,
            reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
          },
        },
      },
    };
    expect(
      resolveCapabilities("deepseek", withIt, "deepseek-v4-flash-vision-exp", noToggle)
        .effortLevels,
    ).toEqual(["low", "high", "max"]);
    const toggleOnly: Registry = {
      deepseek: {
        models: {
          "deepseek-v4-flash-vision-exp": { ...model, reasoning_options: [{ type: "toggle" }] },
        },
      },
    };
    expect(
      resolveCapabilities("deepseek", withIt, "deepseek-v4-flash-vision-exp", toggleOnly)
        .effortLevels,
    ).toBeUndefined();
    const overridden: ProviderConfig = {
      ...DS,
      models: [{ name: "deepseek-v4-flash-vision-exp", effortLevels: ["high"] }],
    };
    expect(
      resolveCapabilities("deepseek", overridden, "deepseek-v4-flash-vision-exp", REG).effortLevels,
    ).toEqual(["high"]);
    // 供应商级窗口:登记簿没有时用它,出处仍是 config
    const withProv: ProviderConfig = { ...DS, contextWindow: 65536 * 2 };
    expect(resolveCapabilities("deepseek", withProv, "deepseek-v4-flash", REG)).toMatchObject({
      contextWindow: 131072,
      source: "config",
    });
    expect(describeCapabilities(vis)).toBe("1M ctx · models.dev");
  });

  it("行注:生效值与出处;配置覆盖了登记簿且不同时带上登记簿的值", () => {
    expect(capabilityNote(REG, "deepseek", DS, "deepseek-v4-pro")).toBe(
      "128k ctx · config (models.dev says 1M)",
    );
    expect(capabilityNote(REG, "deepseek", DS, "deepseek-v4-flash")).toBe("64k ctx · assumed");
    expect(capabilityNote(undefined, "deepseek", DS, "deepseek-v4-pro")).toBe("128k ctx · config");
  });

  it("内置快照:模板里的三家模型都能从快照拿到窗口与价格,出处 models.dev", () => {
    expect(Object.keys(SNAPSHOT)).toEqual(
      expect.arrayContaining(["deepseek", "openai", "anthropic"]),
    );
    for (const [pn, p] of Object.entries(CONFIG_TEMPLATE.providers)) {
      for (const m of p.models) {
        const name = typeof m === "string" ? m : m.name;
        const caps = resolveCapabilities(pn, p, name, SNAPSHOT);
        expect(caps.source, `${pn}/${name}`).toBe("models.dev");
        expect(caps.contextWindow).toBeGreaterThanOrEqual(128000);
        expect(caps.price?.input).toBeGreaterThan(0);
      }
    }
    // 没有缓存文件时同步取到的就是快照
    expect(loadRegistrySync(join(tmpdir(), "clarook-no-such-cache.json"))).toBe(SNAPSHOT);
  });
});

describe("推导", () => {
  it("models.dev 命中:配置里只写名字,生效数据全来自登记簿;出处 models.dev", () => {
    const inf = inferModelConfig("deepseek", DS, "deepseek-v4-flash-vision-exp", REG);
    expect(inf.source).toBe("models.dev");
    expect(inf.model).toEqual({ name: "deepseek-v4-flash-vision-exp" });
    expect(inf.caps.contextWindow).toBe(1_000_000);
    expect(describeInferred(inf)).toBe("1M ctx · models.dev");
  });

  it("登记簿没有:抄最长公共前缀的已配置模型(不带名字)写进配置;没有相似的只写名字按假设", () => {
    const copied = inferModelConfig("deepseek", DS, "deepseek-v4-pro-lite", undefined);
    expect(copied.source).toBe("copied from deepseek-v4-pro");
    expect(copied.model).toEqual({
      name: "deepseek-v4-pro-lite",
      contextWindow: 131072,
      price: { input: 1, output: 2 },
    });
    expect(describeInferred(copied)).toBe("128k ctx · copied from deepseek-v4-pro");
    const assumed = inferModelConfig("deepseek", DS, "totally-new", undefined);
    expect(assumed.source).toBe("assumed 64k context");
    expect(assumed.model).toEqual({ name: "totally-new" });
    expect(assumed.caps.source).toBe("assumed");
    expect(closestConfigured(DS, "deep")).toBeUndefined(); // 少于 6 个字符不算像
  });

  it("供应商 id 按 baseUrl 主机认;找不到直接命中就全库扫", () => {
    expect(registryProviderId("mine", { baseUrl: "https://api.deepseek.com/v1" })).toBe("deepseek");
    expect(registryProviderId("relay", { baseUrl: "https://relay.example.com" })).toBe("relay");
    expect(lookupModel(REG, "relay", "some-model")?.limit?.context).toBe(32000);
  });
});

describe("缓存", () => {
  it("新鲜缓存直接用;过期后联网并重写;联网失败退回旧缓存;没有缓存且失败返回 undefined", async () => {
    const dir = testDirectory("clarook-reg-");
    const path = join(dir, "models.dev.json");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ fresh: { models: {} } }) };
    }) as unknown as typeof fetch;
    expect(await fetchRegistry({ cachePath: path, fetchImpl })).toEqual({ fresh: { models: {} } });
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ fresh: { models: {} } });
    expect(await fetchRegistry({ cachePath: path, fetchImpl })).toEqual({ fresh: { models: {} } });
    expect(calls).toBe(1); // 缓存新鲜,不联网
    expect(loadRegistrySync(path)).toEqual({ fresh: { models: {} } });
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(path, old, old);
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchRegistry({ cachePath: path, fetchImpl: failing })).toEqual({
      fresh: { models: {} },
    });
    const none = join(dir, "missing.json");
    expect(await fetchRegistry({ cachePath: none, fetchImpl: failing })).toBeUndefined();
    writeFileSync(none, "{not json");
    expect(await fetchRegistry({ cachePath: none, fetchImpl: failing })).toBeUndefined();
  });
});

describe("写进配置", () => {
  it("addModel 追加或替换同名模型并落盘;登录对话框里服务器多出来的模型可选,选中先写配置再切换", async () => {
    const dir = testDirectory("clarook-cfg-");
    const path = join(dir, "config.json");
    const config: KernelConfig = {
      default: "deepseek/deepseek-v4-pro",
      providers: { deepseek: DS },
    };
    writeFileSync(path, JSON.stringify(config));
    const next = addModel("deepseek", { name: "deepseek-v4-flash-vision-exp" }, path);
    expect(
      next.providers.deepseek?.models.map((m) => (typeof m === "string" ? m : m.name)),
    ).toEqual(["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
    const again = addModel("deepseek", { name: "deepseek-v4-pro", contextWindow: 1_000_000 }, path);
    expect(again.providers.deepseek?.models).toHaveLength(3);
    expect(JSON.parse(readFileSync(path, "utf8")).providers.deepseek.models).toHaveLength(3);
    expect(() => addModel("nope", { name: "x" }, path)).toThrow('unknown provider "nope"');

    const calls: string[] = [];
    const deps: LoginDeps = {
      providers: () => [{ name: "deepseek", protocol: "openai", models: ["deepseek-v4-pro"] }],
      verifyKey: async () => ["deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
      setKey: () => {},
      describeModel: async (p, m) => inferModelConfig(p, DS, m, REG),
      addModel: (p, m) => calls.push(`add:${p}/${m.name}:${m.contextWindow ?? "live"}`),
      useModel: (name) => calls.push(`use:${name}`),
      onDone: () => calls.push("done"),
      onChange: () => {},
    };
    const dlg = new LoginDialog(deps, { provider: "deepseek" });
    dlg.handleInput("sk-x");
    dlg.handleInput("\r");
    for (let i = 0; i < 20 && !stripAnsi(dlg.render().join("\n")).includes("key saved"); i++)
      await new Promise((r) => setTimeout(r, 5));
    const out = stripAnsi(dlg.render().join("\n"));
    expect(out).toContain("deepseek-v4-flash-vision-exp  not in config · 1M ctx · models.dev");
    dlg.handleInput("\x1b[B");
    dlg.handleInput("\r");
    expect(calls).toEqual([]);
    dlg.handleInput("\r");
    expect(calls).toEqual([
      "add:deepseek/deepseek-v4-flash-vision-exp:live",
      "use:deepseek/deepseek-v4-flash-vision-exp",
      "done",
    ]);
  });
});
