import type { AssistantTurn, CompleteOptions } from "../provider.js";

/** 尝试的收尾包含传输录制;不把展示回调异常吞掉或再次发送成功终态。 */
export async function withStreamAttempt(
  onStream: CompleteOptions["onStream"],
  signal: AbortSignal | undefined,
  generate: (emit: CompleteOptions["onStream"]) => Promise<AssistantTurn>,
): Promise<AssistantTurn> {
  onStream?.({ type: "attempt/start" });
  // 取消后仍可能读到同一字节块中已解码的 SSE 帧;生成预览不能在清理后重新出现。
  const emit: CompleteOptions["onStream"] = onStream
    ? (update) => {
        if (!signal?.aborted) onStream(update);
      }
    : undefined;
  let turn: AssistantTurn;
  try {
    turn = await generate(emit);
  } catch (error) {
    onStream?.({ type: "attempt/end", state: "error" });
    throw error;
  }
  onStream?.({
    type: "attempt/end",
    state: turn.stopReason === "aborted" ? "aborted" : "complete",
  });
  return turn;
}
