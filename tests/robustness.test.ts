// 生产级加固:流停滞、烂 JSON、无 index 的工具调用、bash 超时与大输出、CRLF 编辑、二进制与大文件、
// rg 路径前缀、费用汇总。每一条都对应一次真实环境里会遇到的失败。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../cli/tools/bash.js";
import { editTool, readTool } from "../cli/tools/fs.js";
import { grepTool } from "../cli/tools/search.js";
import { costOf, fmtCost, usageTotals } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import { toolOutput } from "../src/exchange.js";
import { EventLog } from "../src/log.js";
import { toAnthropicWire } from "../src/providers/anthropic.js";
import { isRetryable, ProviderError } from "../src/providers/errors.js";
import { feedChunk, finishAcc, newAcc } from "../src/providers/openai-chat.js";
import { StreamStall, sseData, sseEvents, streamError } from "../src/providers/sse.js";

const enc = new TextEncoder();
async function* chunks(parts: string[], delayMs = 0): AsyncGenerator<Uint8Array> {
  for (const p of parts) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield enc.encode(p);
  }
}
async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const x of it) out.push(x);
  return out;
}
const ctx = { signal: new AbortController().signal };

describe("SSE 读流", () => {
  it("按空行分帧并拼接 data;三种换行与 UTF-8 可跨块,未完成事件不派发", async () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const input = [
        "\uFEFF: keepalive",
        "event: message",
        'data: {"a":',
        'data: "你"}',
        "",
        "data: [DONE]",
        "",
        'data:{"a":2}',
        "",
        'data: {"a":3}',
        "",
      ].join(newline);
      async function* bytes() {
        for (const byte of enc.encode(input)) yield Uint8Array.of(byte);
      }
      expect(await collect(sseEvents(bytes()))).toEqual([{ a: "你" }, { a: 2 }]);
    }
  });

  it("onRaw 收到每一非空行,含非 data 行", async () => {
    const raw: string[] = [];
    const data = await collect(
      sseData(chunks(["event: x\ndata:  first \ndata\n\ndata: unfinished"]), {
        onRaw: (l) => raw.push(l),
      }),
    );
    expect(data).toEqual([" first \n"]);
    expect(raw).toEqual(["event: x", "data:  first ", "data", "data: unfinished"]);
  });

  it("解析不了的完整事件 → 不可重试的 ProviderError,原文随错误带回", async () => {
    await expect(
      collect(sseEvents(chunks(["data: {oops\ndata: broken}\n\n"]))),
    ).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
      body: "{oops\nbroken}",
    });
  });

  it("停滞会撤销请求;已有输出时停滞、断连和流内错误都不重试", async () => {
    let stalled = 0;
    const p = collect(
      sseEvents(chunks(['data: {"a":1}\n\n', 'data: {"a":2}\n\n'], 80), {
        stallTimeoutMs: 20,
        onStall: () => stalled++,
      }),
    );
    await expect(p).rejects.toBeInstanceOf(StreamStall);
    expect(stalled).toBe(1);
    const socket = new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
    const overloaded = new ProviderError("provider stream error: overloaded", {
      retryable: true,
      body: "overloaded",
    });
    for (const error of [new StreamStall(20), socket, overloaded]) {
      expect(streamError(error, false)).toBe(error);
      expect(isRetryable(error)).toBe(true);
      const stopped = streamError(error, true);
      expect(stopped).toBeInstanceOf(ProviderError);
      expect(isRetryable(stopped)).toBe(false);
      expect((stopped as Error).cause).toBe(error);
    }
    expect(streamError(overloaded, true)).toMatchObject({ body: "overloaded" });
    const invalid = new ProviderError("provider stream: malformed data", { retryable: false });
    expect(streamError(invalid, true)).toBe(invalid);
  });

  it("stallTimeoutMs=0 不限时", async () => {
    const got = await collect(sseEvents(chunks(['data: {"a":1}\n\n'], 30), { stallTimeoutMs: 0 }));
    expect(got).toEqual([{ a: 1 }]);
  });
});

describe("OpenAI 兼容流的宽容", () => {
  it("中转站不带 index 的 tool_calls:带 id 开新调用,不带 id 续写最后一个", () => {
    const acc = newAcc();
    feedChunk(acc, {
      choices: [
        { delta: { tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"pa' } }] } },
      ],
    });
    feedChunk(acc, {
      choices: [{ delta: { tool_calls: [{ function: { arguments: 'th":"a"}' } }] } }],
    });
    feedChunk(acc, {
      choices: [
        { delta: { tool_calls: [{ id: "c2", function: { name: "ls", arguments: "{}" } }] } },
      ],
    });
    feedChunk(acc, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    expect(finishAcc(acc, false).toolCalls).toEqual([
      { id: "c1", name: "read", args: { path: "a" } },
      { id: "c2", name: "ls", args: {} },
    ]);
  });
});

describe("Anthropic 线路", () => {
  it("cache:系统提示词与最后一条消息的末块挂断点;不开则没有", () => {
    const msgs = [
      { role: "system" as const, content: "S" },
      { role: "user" as const, content: "u" },
      { role: "assistant" as const, content: "a", toolCalls: [] },
      { role: "user" as const, content: "u2" },
    ];
    const cached = toAnthropicWire(msgs, { cache: true });
    expect(cached.system?.[0]).toEqual({
      type: "text",
      text: "S",
      cache_control: { type: "ephemeral" },
    });
    expect(cached.messages.at(-1)?.content.at(-1)).toMatchObject({
      text: "u2",
      cache_control: { type: "ephemeral" },
    });
    expect(cached.messages[0]?.content[0]).not.toHaveProperty("cache_control");
    const plain = toAnthropicWire(msgs);
    expect(JSON.stringify(plain)).not.toContain("cache_control");
  });

  it("空工具结果用占位文本,不发空内容块", () => {
    const wire = toAnthropicWire([
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: {} }] },
      { role: "tool", callId: "a", name: "read", content: "", isError: false },
    ]);
    expect(wire.messages[1]?.content[0]).toMatchObject({ type: "tool_result", content: "(空)" });
  });
});

describe("bash 工具的边界", () => {
  it("超时 → 杀进程树,错误里带已产出的输出", async () => {
    const tool = createBashTool({ defaultTimeoutS: 1 });
    await expect(
      tool.execute({ command: "echo before; sleep 5; echo after" }, ctx),
    ).rejects.toThrow(/did not finish within 1 s[\s\S]*before/);
  }, 15000);

  it("超过旧 10 MiB 上限仍跑完;模型只见尾部,Recording 保留完整原文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernel-bash-large-"));
    const log = new EventLog(join(dir, "session.jsonl"));
    try {
      const output = toolOutput(log, "large", "bash");
      if (!output) throw new Error("Recording output unavailable");
      const shown = await createBashTool().execute(
        { command: "yes A | head -c 11000000; printf '\\nEND_SENTINEL\\n'" },
        { signal: ctx.signal, output },
      );
      await log.checkpoint();
      expect(shown).toContain("END_SENTINEL");
      expect(shown).toContain("Exit code: 0");
      expect(shown).toContain(`Full output: ${output.path}`);
      expect(Buffer.byteLength(shown)).toBeLessThan(60 * 1024);
      expect(statSync(output.path).size).toBeGreaterThan(10 * 1024 * 1024);
      expect(readFileSync(output.path, "utf8")).toContain("END_SENTINEL");
    } finally {
      log.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("timeout 参数覆盖缺省", async () => {
    const out = await createBashTool().execute({ command: "echo ok", timeout: 30 }, ctx);
    expect(out).toBe("ok");
  });
});

describe("文件工具的边界", () => {
  const dir = mkdtempSync(join(tmpdir(), "kernel-robust-"));

  it("edit:CRLF 文件按 LF 匹配、按 CRLF 写回", async () => {
    const file = join(dir, "crlf.txt");
    writeFileSync(file, "a\r\nb\r\nc\r\n");
    await editTool.execute({ path: file, oldText: "a\nb", newText: "x\ny\nz" }, ctx);
    expect(readFileSync(file, "utf8")).toBe("x\r\ny\r\nz\r\nc\r\n");
  });

  it("edit:混合换行时未修改的行保持原样", async () => {
    const file = join(dir, "mixed-eol.txt");
    writeFileSync(file, "first\r\nsecond\nthird\r\n");
    await editTool.execute({ path: file, oldText: "second", newText: "changed" }, ctx);
    expect(readFileSync(file, "utf8")).toBe("first\r\nchanged\nthird\r\n");
  });

  it("edit:非法 UTF-8 拒绝修改,原始字节不变", async () => {
    const file = join(dir, "invalid-utf8.txt");
    const original = Buffer.from([0x61, 0xff, 0x62]);
    writeFileSync(file, original);
    await expect(editTool.execute({ path: file, oldText: "a", newText: "x" }, ctx)).rejects.toThrow(
      /not valid UTF-8 text; edit refused/,
    );
    expect(readFileSync(file)).toEqual(original);
  });

  it("edit:含 NUL 的文件拒绝修改,避免把二进制当作文本重写", async () => {
    const file = join(dir, "utf16-like.txt");
    const original = Buffer.from([0x61, 0x00, 0x62, 0x00]);
    writeFileSync(file, original);
    await expect(editTool.execute({ path: file, oldText: "a", newText: "x" }, ctx)).rejects.toThrow(
      /contains NUL bytes/,
    );
    expect(readFileSync(file)).toEqual(original);
  });

  it("edit:oldText 为空 → 报错", async () => {
    const file = join(dir, "e.txt");
    writeFileSync(file, "abc");
    await expect(editTool.execute({ path: file, oldText: "", newText: "x" }, ctx)).rejects.toThrow(
      /must not be empty/,
    );
  });

  it("read:二进制文件 → 报错而不是吐乱码", async () => {
    const file = join(dir, "bin.dat");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    await expect(readTool.execute({ path: file }, ctx)).rejects.toThrow(/binary/);
  });

  it("read:目录 → 列举条目,目录在前带 /,文件带字节数", async () => {
    const sub = join(dir, "listing");
    mkdirSync(join(sub, "deep"), { recursive: true });
    writeFileSync(join(sub, "a.txt"), "abc");
    const listing = await readTool.execute({ path: sub }, ctx);
    expect(listing.split("\n")).toEqual(["deep/", "a.txt  3 B"]);
    expect(await readTool.execute({ path: join(sub, "deep") }, ctx)).toBe("(empty directory)");
  });

  it("read:空文件正常返回", async () => {
    const file = join(dir, "empty.txt");
    writeFileSync(file, "");
    expect(await readTool.execute({ path: file }, ctx)).toBe("1\t");
  });

  it("grep:搜索根不是工作目录时,路径带上相对前缀", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "hit.txt"), "needle here\n");
    // 给模型的路径 = 用户给的 path + rg 输出的相对路径,原样可再喂给 read。
    const out = await grepTool.execute({ pattern: "needle", path: sub }, ctx);
    const expected = `${sub.split("\\").join("/")}/hit.txt`;
    expect(out).toContain(`${expected}:1:needle here`);
    const rel = relative(process.cwd(), sub).split("\\").join("/");
    const out2 = await grepTool.execute({ pattern: "needle", path: rel }, ctx);
    expect(out2).toContain(`${rel}/hit.txt:1:needle here`);
  });
});

describe("费用汇总", () => {
  const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

  it("costOf:缓存命中与写入各按自己的单价,其余按 input", () => {
    const usd = costOf(
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 100_000,
      },
      price,
    );
    // 400k 普通输入 ×3 + 500k 命中 ×0.3 + 100k 写入 ×3.75 + 100k 输出 ×15
    expect(usd).toBeCloseTo(1.2 + 0.15 + 0.375 + 1.5, 6);
  });

  it("usageTotals:正常步与压缩摘要请求都计入;没价格就没 cost", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: "", model: "m", system: "" },
      { type: "user/message", at: "", text: "hi" },
      {
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      { type: "compaction", at: "", summary: "s", usage: { inputTokens: 50, outputTokens: 5 } },
    ];
    const t = usageTotals(events, () => price);
    expect(t).toMatchObject({ requests: 2, inputTokens: 150, outputTokens: 15 });
    expect(t.cost).toBeCloseTo((150 * 3 + 15 * 15) / 1e6, 9);
    expect(usageTotals(events).cost).toBeUndefined();
    expect(
      usageTotals(
        [
          ...events,
          { type: "assistant/message", at: "", text: "done", toolCalls: [], stopReason: "end" },
        ],
        () => price,
      ).cost,
    ).toBeUndefined();
  });

  it("fmtCost 按量级取位", () => {
    expect(fmtCost(0.00123)).toBe("$0.0012");
    expect(fmtCost(0.5)).toBe("$0.500");
    expect(fmtCost(12.345)).toBe("$12.35");
  });
});
