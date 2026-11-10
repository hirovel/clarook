// 请求正文格式器:将输入、响应和已读取的证据转成内容块;选择与展开归正文浏览模块。
import type { Message } from "../src/messages.js";
import type { SystemPrompt } from "../src/system-prompt.js";
import type { BodyBlock } from "./body-browser.js";
import { compareInputs, textDifferenceLabel } from "./input-comparison.js";
import { firstLine, fmtMs, messageTokens, pctOf, roleLabel } from "./inspector-format.js";
import { messageBodyLines, type RequestRecord } from "./inspector-requests.js";
import type { RecordedBody, RequestRecording } from "./session-records.js";
import { editPreviewItems, toolCallDetail, visibleSourceText } from "./tui-format.js";

function textBlock(id: string, title: string, text: string, meta = ""): BodyBlock {
  let preview = firstLine(visibleSourceText(text.slice(0, 512)));
  if (text.length < 4096 && (text.startsWith("{") || text.startsWith("["))) {
    try {
      preview = visibleSourceText(JSON.stringify(JSON.parse(text)));
    } catch {
      /* 不是 JSON 时保留实际首行。 */
    }
  }
  return {
    id,
    title,
    meta: `${text.length} chars${meta ? ` · ${meta}` : ""}`,
    preview,
    version: text,
    lines: () => visibleSourceText(text).split("\n"),
  };
}

export function recordingErrorBlock(error: string): BodyBlock {
  return textBlock("recording-error", "Recording unavailable or damaged", error);
}

function recordedBlock(
  id: string,
  title: string,
  body: RecordedBody | undefined,
  text: string,
  meta: string,
): BodyBlock {
  if (!body) return textBlock(id, title, text, meta);
  return {
    id,
    title,
    meta: `${body.bytes === undefined ? "streaming bytes" : `${body.bytes} bytes`} · ${meta}`,
    preview: "Enter to read captured body",
    version: body,
    lines: () => visibleSourceText(body.read()).split("\n"),
  };
}

export function inputBlocks(
  messages: Message[],
  prompt?: SystemPrompt,
  previous?: Message[],
): BodyBlock[] {
  const tokens = messages.map(messageTokens);
  const total = tokens.reduce((n, size) => n + size, 0);
  const comparison = compareInputs(
    previous ? { origin: "history-projection", messages: previous } : undefined,
    { origin: "history-projection", messages, system: prompt },
  );
  const keep = comparison.text.sameMessages;
  return messages.map((message, i) => ({
    ...(i === 0 && {
      divider: previous
        ? keep > 0
          ? "Same message text prefix"
          : "Changed message text from here"
        : "First input",
    }),
    ...(previous &&
      keep > 0 &&
      i === keep && {
        divider: keep === previous.length ? "Added since previous input" : "Changed tail from here",
      }),
    id: `message-${i}`,
    version: message,
    title: `${i + 1}. ${roleLabel(message)}`,
    meta: `~${tokens[i]} text tok · ${pctOf(tokens[i] as number, total)}${message.role === "user" && message.images?.length ? ` · ${message.images.length} image(s), tokens unestimated` : ""}${previous ? (i < keep ? " · unchanged text prefix" : " · after text prefix") : ""}${message.edited ? " · edited" : ""}${comparison.text.first?.message === i ? ` · ${textDifferenceLabel(comparison.text.first)}` : ""}`,
    preview:
      firstLine(visibleSourceText(message.content.slice(0, 512))) ||
      (message.role === "assistant" ? `${message.toolCalls.length} tool calls` : "(empty)"),
    // 共用消息格式器,不再维护另一套思考、opaque、工具参数的正文格式。
    lines: () => messageBodyLines(message, false, prompt),
  }));
}

export function receivedBlocks(rec: RequestRecord, saved?: RequestRecording): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  if (rec.error) {
    const detail = rec.error.status !== undefined ? `HTTP ${rec.error.status}` : rec.error.kind;
    blocks.push(
      textBlock("error", `Request failed${detail ? ` · ${detail}` : ""}`, rec.error.error),
    );
  }
  if (rec.compaction)
    blocks.push(
      textBlock(
        "summary",
        "Compaction summary",
        rec.compaction.summary ?? "(none)",
        "available to later requests",
      ),
    );
  const reply = rec.response;
  if (reply) {
    if (reply.text || !reply.toolCalls.length)
      blocks.push(
        textBlock(
          "reply",
          "Reply",
          reply.text || "(empty)",
          `${reply.stopReason} · ${fmtMs(reply.latencyMs)}`,
        ),
      );
  }
  // 执行返回和模型结果分别来自事实;附件只补充原始输出字节。
  const outputs = new Map((saved?.outputs ?? []).map((output) => [output.callId, output]));
  const results = new Map(rec.results.map((result) => [result.callId, result]));
  const executions = new Map(
    (rec.executions ?? []).map((execution) => [execution.event.callId, execution]),
  );
  const outcome = (
    result: Pick<RequestRecord["results"][number], "outcome" | "isError"> | undefined,
  ) =>
    !result
      ? "result not recorded"
      : result.outcome === "unknown"
        ? "outcome unknown"
        : result.isError
          ? "error"
          : "success";
  const addOriginal = (
    output: NonNullable<RequestRecording["outputs"]>[number],
    group?: BodyBlock["group"],
  ) => {
    blocks.push({
      ...recordedBlock(
        `original-${output.callId}`,
        group ? "Original output" : `${output.name} · original output`,
        output.body,
        output.original,
        `${output.source} · ${output.state}`,
      ),
      ...(group && { group }),
    });
  };
  const addEvidence = (callId: string, group?: BodyBlock["group"], name?: string) => {
    const result = results.get(callId);
    const found = executions.get(callId);
    const execution = !name || found?.event.name === name ? found : undefined;
    const pending = execution && result?.executionEvent !== execution.index;
    if (execution) {
      const state = outcome(execution.event);
      blocks.push({
        ...textBlock(
          `execution-${callId}`,
          `${group ? "Execution result" : `${execution.event.name} · execution result`} · ${state}`,
          execution.event.content,
          `${callId} · ${state} · ${fmtMs(execution.event.durationMs)} · execution #${execution.index} · call event #${execution.event.callEvent}${pending ? " · model result pending" : ""}`,
        ),
        ...(group && { group }),
      });
      executions.delete(callId);
    }
    const output = outputs.get(callId);
    if (output) {
      addOriginal(output, group);
      outputs.delete(callId);
    }
    if (pending)
      blocks.push({
        ...textBlock(
          `pending-${callId}`,
          "Result for model · pending",
          "Execution returned, but no final model result referencing this execution is recorded. The execution result does not verify external effects.",
        ),
        ...(group && { group }),
      });
    if (!result) return;
    const state = outcome(result);
    blocks.push({
      ...textBlock(
        `model-${result.callId}`,
        `${group ? "Result for model" : `${result.name} · model result`} · ${state}`,
        result.content,
        `${result.callId} · ${state} · available to later requests${result.executionEvent === undefined ? " · No execution reference recorded" : ` · execution #${result.executionEvent}`}`,
      ),
      ...(group && { group }),
    });
    results.delete(callId);
  };
  for (const call of reply?.toolCalls ?? []) {
    const prepared = rec.prepared?.find(
      (input) =>
        input.callEvent === rec.responseIndex &&
        input.callId === call.id &&
        input.name === call.name,
    );
    const previewArgs = prepared ? prepared.args : call.args;
    const modelArgs =
      call.args && typeof call.args === "object"
        ? (call.args as Record<string, unknown>)
        : undefined;
    const args =
      previewArgs && typeof previewArgs === "object"
        ? (previewArgs as Record<string, unknown>)
        : undefined;
    const target =
      typeof args?.path === "string"
        ? args.path
        : typeof args?.command === "string"
          ? args.command
          : "";
    // 摘要只保留末两段目录,完整路径和命令仍在展开的参数原文中。
    const displayTarget =
      typeof args?.path === "string"
        ? args.path
            .split(/[\\/]/)
            .slice(-2)
            .join(args.path.includes("\\") ? "\\" : "/")
        : target;
    const group = {
      id: call.id,
      title: firstLine(
        visibleSourceText(`${call.name}${displayTarget ? ` · ${displayTarget}` : ""}`),
      ),
      ...(typeof args?.path === "string" && {
        compactTitle: firstLine(
          visibleSourceText(`${call.name} · ${args.path.split(/[\\/]/).at(-1)}`),
        ),
      }),
    };
    const block = textBlock(
      `call-${call.id}`,
      "Model arguments",
      JSON.stringify(call.args, null, 2),
      `${call.id} · original model request${prepared ? "" : " · No preparation fact recorded"}${executions.get(call.id)?.event.name === call.name ? "" : " · No execution fact recorded"}`,
    );
    // 缺失说明先于规模和调用ID,窄屏截短也不能把它隐藏。
    if (!results.has(call.id)) block.meta = `result not recorded · ${block.meta}`;
    blocks.push({
      ...block,
      group,
      preview: Object.keys(modelArgs ?? {}).join(" · ") || "(no arguments)",
    });
    if (prepared)
      blocks.push({
        ...textBlock(
          `prepared-${call.id}`,
          "Prepared arguments",
          JSON.stringify(prepared.args, null, 2),
          `${call.id} · prepared for approval · execution not implied`,
        ),
        group,
        preview: Object.keys(args ?? {}).join(" · ") || "(no arguments)",
      });
    const edits = call.name === "edit" ? editPreviewItems(previewArgs) : [];
    const edit = edits.length > 0;
    const write = call.name === "write" && typeof args?.content === "string";
    if (edit || write) {
      const state = outcome(results.get(call.id));
      blocks.push({
        id: `change-${call.id}`,
        group,
        title: `${edit ? (prepared ? "Prepared replacement" : "Requested replacement") : prepared ? "Prepared file content" : "Submitted file content"} · ${state}`,
        meta: edit
          ? `Parameter preview · ${edits.length} edit${edits.length === 1 ? "" : "s"} · not a full-file diff`
          : "Previous file content not recorded · not a full-file diff",
        preview: `Enter to inspect · complete parameters in ${prepared ? "Prepared arguments" : "Model arguments"}`,
        version: prepared ?? call,
        // 从已记录参数按需排版,不读当前文件,不把预览误作真实文件快照。
        lines: () => toolCallDetail(call.name, previewArgs, "full").split("\n").filter(Boolean),
      });
    }
    addEvidence(call.id, group, call.name);
  }
  // 记录不完整时仍显示未匹配证据,不因缺少对应调用而删掉结果。
  for (const callId of results.keys()) addEvidence(callId);
  for (const callId of executions.keys()) addEvidence(callId);
  for (const output of outputs.values()) addOriginal(output);
  for (const attempt of saved?.attempts ?? [])
    blocks.push(
      recordedBlock(
        `http-${attempt.n}`,
        `HTTP attempt ${attempt.n} · ${attempt.status ?? "no response"}`,
        attempt.body,
        attempt.response,
        `capture ${attempt.state}`,
      ),
    );
  const usage = reply?.usage ?? rec.compaction?.usage;
  if (usage)
    blocks.push(
      textBlock(
        "usage",
        "Usage · reported by provider",
        JSON.stringify(usage, null, 2),
        `${usage.inputTokens} input · ${usage.outputTokens} output tokens`,
      ),
    );
  if (!saved?.attempts?.length)
    blocks.push(
      textBlock(
        "capture-unavailable",
        "No HTTP response captured",
        "No saved HTTP response is available for this request. Parsed events are not the original HTTP body.",
      ),
    );
  if (reply?.reasoning)
    blocks.push(
      textBlock(
        "reasoning",
        reply.reasoningKind === "summary" ? "Thinking summary · display only" : "Thinking text",
        reply.reasoning,
      ),
    );
  if (reply?.opaque !== undefined)
    blocks.push(
      textBlock(
        "opaque",
        "Provider state · retained for adapter",
        JSON.stringify(reply.opaque, null, 2),
      ),
    );
  if (reply?.extras && Object.keys(reply.extras).length)
    blocks.push(textBlock("metadata", "Provider metadata", JSON.stringify(reply.extras, null, 2)));
  if (saved?.error) blocks.unshift(recordingErrorBlock(saved.error));
  return blocks;
}
