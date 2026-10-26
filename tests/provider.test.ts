import { describe, expect, it } from "vitest";
import { feedChunk, finishAcc, newAcc } from "../src/providers/openai-chat.js";

// SSE 累积是纯函数,不碰网络即可测:这是把流解析从 fetch 里拆出来的全部理由。
describe("stream accumulation", () => {
  it("正文与可见拒绝按到达顺序拼接 + finish_reason=stop → end", () => {
    const acc = newAcc();
    expect(feedChunk(acc, { choices: [{ delta: { content: "你" } }] })).toBe("你");
    expect(feedChunk(acc, { choices: [{ delta: { content: "好" } }] })).toBe("好");
    feedChunk(acc, { choices: [{ delta: {}, finish_reason: "stop" }] });
    feedChunk(acc, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });

    const turn = finishAcc(acc, false);
    expect(turn).toEqual({
      text: "你好",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 2 },
      extras: { finish_reason: "stop" },
    });
    for (const prefix of ["", "说明："]) {
      const refusal = newAcc();
      expect(
        feedChunk(refusal, { choices: [{ delta: { content: prefix, refusal: "不能" } }] }),
      ).toBe(`${prefix}不能`);
      expect(feedChunk(refusal, { choices: [{ delta: { refusal: "提供" } }] })).toBe("提供");
      feedChunk(refusal, { choices: [{ delta: {}, finish_reason: "stop" }] });
      expect(finishAcc(refusal, false)).toMatchObject({
        text: `${prefix}不能提供`,
        toolCalls: [],
        stopReason: "end",
      });
    }
  });

  it("tool_calls 按 index 分片累积,参数 JSON 跨 chunk 拼合", () => {
    const acc = newAcc();
    feedChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }],
          },
        },
      ],
    });
    feedChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }],
    });
    feedChunk(acc, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });

    const turn = finishAcc(acc, false);
    expect(turn.stopReason).toBe("tool");
    expect(turn.toolCalls).toEqual([{ id: "c1", name: "read", args: { path: "a.txt" } }]);
  });

  it("参数 JSON 残缺不抛错,包成 __unparsed 交给工具层回喂", () => {
    const acc = newAcc();
    feedChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"broken' } }],
          },
        },
      ],
    });
    expect(() => finishAcc(acc, false)).toThrow("stream ended without finish_reason");
    feedChunk(acc, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    const turn = finishAcc(acc, false);
    expect(turn.toolCalls[0]?.args).toEqual({ __unparsed: '{"broken' });
  });

  it("aborted:保留半截文本,丢弃未完成的 toolCalls", () => {
    const acc = newAcc();
    feedChunk(acc, { choices: [{ delta: { content: "我正在" } }] });
    feedChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{" } }],
          },
        },
      ],
    });
    const turn = finishAcc(acc, true);
    expect(turn).toMatchObject({ text: "我正在", toolCalls: [], stopReason: "aborted" });
  });
});
