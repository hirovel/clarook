// 真实供应商跑完之后的对照(cli/checkup.ts):判据要能在真数据上说对话,所以先在造出来的会话上验它。
// 一条干净会话该全过;一条有毛病的会话该逐条指出毛病在第几次请求。
import { describe, expect, it } from "vitest";
import { analyze, reportLines } from "../cli/checkup.js";
import { usageTotals } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";

const at = "2026-09-07T10:00:00.000Z";
type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
};

const request = (
  messages: number,
  est: number,
  reason: "turn" | "compaction" = "turn",
): AgentEvent => ({
  type: "request",
  at,
  model: "m",
  messages,
  tools: ["read", "bash"],
  estimatedTokens: est,
  reason,
});
const reply = (
  text: string,
  usage: Usage,
  calls: { id: string; name: string }[] = [],
): AgentEvent => ({
  type: "assistant/message",
  at,
  text,
  toolCalls: calls.map((c) => ({ ...c, args: {} })),
  stopReason: calls.length > 0 ? "tool" : "end",
  usage,
  latencyMs: 900,
});
const result = (callId: string, name: string, content: string, isError = false): AgentEvent => ({
  type: "tool/result",
  at,
  callId,
  name,
  content,
  isError,
  durationMs: 5,
});

/** 首次纯估算遗漏工具定义;后续估算已有供应商用量作基准。 */
function clean(): AgentEvent[] {
  return [
    { type: "session/start", at, model: "m", system: "s".repeat(8000) },
    { type: "user/message", at, text: "q1" },
    request(2, 2000),
    reply("reading", { inputTokens: 4000, outputTokens: 20, cacheReadTokens: 0 }, [
      { id: "c1", name: "read" },
    ]),
    result("c1", "read", "file body"),
    request(4, 4030),
    reply("more", { inputTokens: 4100, outputTokens: 20, cacheReadTokens: 2000 }, [
      { id: "c2", name: "read" },
    ]),
    result("c2", "read", "another file"),
    request(6, 4130),
    reply("still", { inputTokens: 4200, outputTokens: 20, cacheReadTokens: 2100 }, [
      { id: "c3", name: "read" },
    ]),
    result("c3", "read", "a third file"),
    request(8, 4230),
    reply("done", { inputTokens: 4300, outputTokens: 30, cacheReadTokens: 3584 }),
  ];
}

const byId = (events: AgentEvent[]) =>
  Object.fromEntries(analyze(events).checks.map((c) => [c.id, c]));

describe("会话对照", () => {
  it("干净会话:前缀整段保留、日志重建得出、估算差额稳定、缓存跟上预测、工具全过", () => {
    const events = clean();
    const c = analyze(events);
    expect(c.requests).toBe(4);
    // 每一步只在末尾追加:上一次发出的整段消息仍是这一次的前缀
    expect(c.rows[1]).toMatchObject({ keep: 2, prevLen: 2, changedBefore: false });
    expect(c.rows[3]).toMatchObject({ keep: 6, prevLen: 6, rebuilt: 8 });
    expect(c.rows[1]?.predicted).toBeGreaterThan(1024);
    const k = byId(events);
    for (const id of ["A", "B", "C", "D", "G"]) expect(k[id]?.status, id).toBe("pass");
    for (const id of ["E", "F", "H", "I"]) expect(k[id]?.status, id).toBe("skip");
    expect(k.C?.detail).toContain("3 comparable");
    expect(k.C?.detail).toContain("1 excluded");
    expect(k.D?.detail).toContain("3 of 4 requests report cache hits");
    const withImage = clean();
    withImage.splice(11, 0, {
      type: "user/message",
      at,
      text: "What is in this image?",
      images: [{ mimeType: "image/png", data: "AAAA" }],
    });
    (withImage[12] as { messages: number }).messages = 9;
    (withImage[13] as { usage: Usage }).usage = { inputTokens: 15000, outputTokens: 20 };
    withImage.push(
      { type: "user/message", at, text: "Continue" },
      request(11, 15030),
      reply("continued", { inputTokens: 15050, outputTokens: 20 }),
    );
    const imageCheck = analyze(withImage);
    expect(imageCheck.rows[3]?.comparable).toBe(false);
    expect(imageCheck.rows[4]?.comparable).toBe(true);
    expect(imageCheck.checks.find((x) => x.id === "C")?.status).toBe("pass");
    expect(imageCheck.checks.find((x) => x.id === "C")?.detail).toContain("new image");
    // 同一模型与工具也不足以比较:压缩重置估算,策略请求可自带正文。
    const reset = clean();
    reset.splice(5, 0, { type: "compaction", at, cleared: [4], strategy: "clear" });
    expect(byId(reset).C?.status).toBe("skip");
    const corruptCache = clean();
    (corruptCache[12] as { usage: Usage }).usage.cacheReadTokens = 5000;
    expect(byId(corruptCache).D?.status).toBe("fail");
    const text = reportLines("s.jsonl", events.length, c, usageTotals(events)).join("\n");
    expect(text).toContain("4 requests");
    expect(text).toContain("PASS  A");
    expect(text).not.toContain("$");
  });

  it("前缀:末尾追加不算打断;编辑之后的重算有解释,不报错", () => {
    // 计划复述与日期附注都是在末尾追加一条用户消息:前缀不该断。
    const appended = clean();
    appended.splice(11, 0, { type: "user/message", at, text: "[plan] restated" });
    expect(byId(appended).A?.status).toBe("pass");

    // 编辑改的是投影里靠前的一条,重算是应该的:changedBefore 记下了原因,判据放行。
    const edited = clean();
    edited.splice(11, 0, { type: "context/edit", at, target: 1, field: "content", value: "q1 v2" });
    const c = analyze(edited);
    const last = c.rows[3] as NonNullable<(typeof c.rows)[number]>;
    expect(last.changedBefore).toBe(true);
    expect(last.keep).toBeLessThan(last.prevLen); // 前缀确实断了
    expect(c.checks.find((x) => x.id === "A")?.status).toBe("pass");
    // 组装槽增加的临时尾部也属于请求正文,下一步删掉它确实打断前缀。
    const custom = clean();
    const first = custom[2] as Extract<AgentEvent, { type: "request" }>;
    first.messages = 3;
    first.body = { prefixEvents: 2, tail: [{ role: "user", content: "temporary reminder" }] };
    expect(byId(custom).A?.status).toBe("fail");
    expect(byId(custom).B?.status).toBe("pass");
  });

  it("日志重建不出发出去的东西:B 指出是第几次请求", () => {
    const events = clean();
    (events[8] as { messages: number }).messages = 99;
    const b = byId(events).B;
    expect(b?.status).toBe("fail");
    expect(b?.detail).toContain("#3 (sent 99, rebuilds to 6)");
  });

  it("压缩比较事件两侧投影,不把压缩前新增的工具结果误报为增长", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at, model: "m", system: "s".repeat(400) },
      { type: "user/message", at, text: "compare files" },
      request(2, 100),
      reply("reading", { inputTokens: 200, outputTokens: 10 }, [{ id: "c1", name: "read" }]),
      result("c1", "read", "R".repeat(8000)),
      request(4, 2100, "compaction"),
      {
        type: "compaction",
        at,
        summary: "key facts",
        coversFrom: 2,
        coversUpTo: 5,
        strategy: "llm",
      },
      request(3, 400),
    ];
    expect(byId(events).E).toMatchObject({ status: "pass" });
    // 完整摘要可由用户选择保留，即使更长；报告不能沿用旧的强制缩小规则。
    const growing = structuredClone(events);
    const summary = growing[6];
    if (summary?.type !== "compaction") throw new Error("Missing summary fixture");
    summary.summary = "Detailed handoff. ".repeat(700);
    const reviewed = (acceptance: string): AgentEvent[] => [
      ...growing.slice(0, 6),
      {
        type: "ext/event",
        at,
        source: "setup",
        kind: "setting",
        payload: { key: "compactionAcceptance", value: acceptance, scope: "session" },
      },
      ...growing.slice(6),
    ];
    expect(byId(reviewed("complete")).E).toMatchObject({ status: "pass" });
    expect(byId(reviewed("complete")).E?.detail).toContain("complete permits");
    expect(byId(reviewed("smaller")).E).toMatchObject({ status: "fail" });
    expect(byId(growing).E).toMatchObject({ status: "skip" });
  });

  it("有毛病的会话:估算差额跳变、压缩无进展、失败没恢复、工具错误率高", () => {
    const events = clean();
    // 第四次请求的实测跳到三倍:估算口径跑偏了
    (events[12] as { usage: Usage }).usage = { inputTokens: 12000, outputTokens: 30 };
    // 两个工具结果都失败
    (events[4] as { isError: boolean }).isError = true;
    (events[7] as { isError: boolean }).isError = true;
    (events[10] as { isError: boolean }).isError = true;
    // 无效的压缩事件没有改变上下文;最后一次请求失败且没有恢复
    events.push({ type: "compaction", at, cleared: [], strategy: "clear" }, request(3, 9000), {
      type: "request/error",
      at,
      error: "upstream exploded",
      status: 500,
      kind: "server",
    });
    const k = byId(events);
    expect(k.C?.status).toBe("fail");
    expect(k.C?.detail).toContain("off: #4");
    expect(k.E?.status).toBe("fail");
    expect(k.E?.detail).toContain("(no drop)");
    expect(k.F?.status).toBe("fail");
    expect(k.F?.detail).toContain("never recovered");
    expect(k.G?.status).toBe("fail");
    expect(k.G?.detail).toContain("read 3 (3 failed)");
    const text = reportLines("s.jsonl", events.length, analyze(events), usageTotals(events)).join(
      "\n",
    );
    expect(text).toContain("✗ server 500");
    expect(text).toContain("FAIL  C");
  });

  it("思考记录:零用量不是丢失,未知不能推断,明确的全文记录矛盾才失败", () => {
    const events = clean();
    const first = events[3] as Extract<AgentEvent, { type: "assistant/message" }>;
    first.reasoning = "why";
    first.reasoningKind = "full";
    (events[6] as { usage: Usage }).usage.reasoningTokens = 0;
    expect(byId(events).H?.status).toBe("pass");
    const missing = events[9] as Extract<AgentEvent, { type: "assistant/message" }>;
    missing.reasoningKind = "full";
    missing.usage = { inputTokens: 4200, outputTokens: 20, reasoningTokens: 8 };
    expect(byId(events).H?.status).toBe("fail");
    expect(byId(clean()).H?.status).toBe("skip");
  });

  it("旁路文件:给了就判它覆盖每一次请求", () => {
    const events = clean();
    expect(
      analyze(events, { lines: 40, requests: [2, 5, 8, 11] }).checks.find((k) => k.id === "I"),
    ).toMatchObject({ status: "pass", detail: "40 lines covering 4 of 4 requests" });
    expect(
      analyze(events, { lines: 9, requests: [2] }).checks.find((k) => k.id === "I")?.status,
    ).toBe("fail");
    expect(
      analyze(events, { lines: 40, requests: [2, 5, 8, 99] }).checks.find((k) => k.id === "I")
        ?.status,
    ).toBe("fail");
  });
});
