// 比较只解释已有证据,不准备请求、不推断服务端缓存,也不改变 adapter 的回传规则。
import { isDeepStrictEqual } from "node:util";
import type { AgentEvent } from "../src/events.js";
import { type Message, requestMessages } from "../src/messages.js";
import type { ToolDef } from "../src/provider.js";
import { type SystemPrompt, systemAt, systemParts, systemText } from "../src/system-prompt.js";
import { modelToolDefinitions, toolDefinitionsForRequest } from "../src/tool-definitions.js";

export type ChangeStatus = "same" | "changed" | "unknown";

export type InputSnapshot = {
  origin: "recorded-input" | "history-projection" | "current-candidate";
  messages: readonly Message[];
  /** 未提供表示缺证据;显式 undefined 表示已知没有 system 文档。 */
  system?: SystemPrompt | undefined;
  tools?: readonly ToolDef[] | undefined;
  model?: string | undefined;
  wire?: { origin: "captured" | "reconstructed"; body: string } | undefined;
};

export type TextDifference = {
  message: number;
  sameChars: number;
  oldChars: number;
  newChars: number;
  section?: { name: string; char: number };
};

export type InputComparison = {
  text: { status: ChangeStatus; sameMessages: number; first?: TextDifference };
  document: { status: ChangeStatus; sections: string[] };
  tools: ChangeStatus;
  model: ChangeStatus;
  /** 本地 marker、图片、reasoning 与 opaque 的变化,发送影响由 provider 决定。 */
  providerState: ChangeStatus;
  wire: { bytes: ChangeStatus; json: ChangeStatus };
};

/** 请求边界决定所有历史字段;实录缺失时只重放当时的日志,绝不借用当前工具目录。 */
export function requestSnapshot(
  events: readonly AgentEvent[],
  index: number,
  saved?: { messages: readonly Message[]; tools: readonly ToolDef[] },
  wire?: InputSnapshot["wire"],
): InputSnapshot {
  const request = events[index];
  return {
    origin: saved ? "recorded-input" : "history-projection",
    messages: saved?.messages ?? requestMessages(events, index),
    ...(request?.type === "request" && {
      model: request.model,
      system: systemAt(events, request.body?.prefixEvents ?? index),
      tools: saved?.tools ?? toolDefinitionsForRequest(events, index),
    }),
    ...(wire && { wire }),
  };
}

/** 可读正文与调用参数的比较;来源标记、图片与私有回传状态另列,不能冒充 wire 等价。 */
function messageText(message: Message): unknown {
  switch (message.role) {
    case "assistant":
      return { role: message.role, content: message.content, toolCalls: message.toolCalls };
    case "tool":
      return {
        role: message.role,
        content: message.content,
        name: message.name,
        callId: message.callId,
        isError: message.isError,
      };
    default:
      return { role: message.role, content: message.content };
  }
}

export function unchangedTextPrefix(
  previous: readonly Message[] | undefined,
  current: readonly Message[],
): number {
  if (!previous) return 0;
  let keep = 0;
  while (keep < previous.length && keep < current.length) {
    const before = previous[keep] as Message;
    const after = current[keep] as Message;
    if (before !== after && !isDeepStrictEqual(messageText(before), messageText(after))) break;
    keep++;
  }
  return keep;
}

function replayState(message: Message): unknown {
  return {
    edited: message.edited,
    prefixChanged: message.prefixChanged,
    ...(message.role === "assistant" && {
      reasoning: message.reasoning,
      reasoningKind: message.reasoningKind,
      opaque: message.opaque,
    }),
    ...(message.role === "user" && { images: message.images }),
  };
}

function sectionAt(prompt: SystemPrompt | undefined, content: string, position: number) {
  if (systemText(prompt) !== content) return undefined;
  let start = 0;
  for (const section of systemParts(prompt).filter((part) => part.enabled && part.text)) {
    if (position >= start && position <= start + section.text.length)
      return { name: section.name, char: position - start + 1 };
    start += section.text.length + 2;
  }
  return undefined;
}

/** 只有两端的实际捕获可证明 HTTP 字节或 JSON 结构;重建预览不升级为历史事实。 */
export function compareInputs(
  before: InputSnapshot | undefined,
  after: InputSnapshot,
): InputComparison {
  const sameMessages = unchangedTextPrefix(before?.messages, after.messages);
  const result: InputComparison = {
    text: {
      status: !before
        ? "unknown"
        : sameMessages === before.messages.length && sameMessages === after.messages.length
          ? "same"
          : "changed",
      sameMessages,
    },
    document: { status: "unknown", sections: [] },
    tools:
      before?.tools === undefined || after.tools === undefined
        ? "unknown"
        : isDeepStrictEqual(modelToolDefinitions(before.tools), modelToolDefinitions(after.tools))
          ? "same"
          : "changed",
    model:
      before?.model === undefined || after.model === undefined
        ? "unknown"
        : before.model === after.model
          ? "same"
          : "changed",
    providerState: before
      ? before.messages.every((message, i) => {
          const next = after.messages[i];
          return next && isDeepStrictEqual(replayState(message), replayState(next));
        })
        ? "same"
        : "changed"
      : "unknown",
    wire: { bytes: "unknown", json: "unknown" },
  };
  if (!before) return result;
  const old = before.messages[sameMessages];
  const next = after.messages[sameMessages];
  if (old && next && old.role === next.role && old.content !== next.content) {
    let sameChars = 0;
    while (sameChars < Math.min(old.content.length, next.content.length)) {
      if (old.content[sameChars] !== next.content[sameChars]) break;
      sameChars++;
    }
    // 前后都能对应各自文档时,字符位置才有可信段身份;assemble 替换不能归给保存段。
    const section =
      next.role === "system" && systemText(before.system) === old.content
        ? sectionAt(after.system, next.content, sameChars)
        : undefined;
    result.text.first = {
      message: sameMessages,
      sameChars,
      oldChars: old.content.length,
      newChars: next.content.length,
      ...(section && { section }),
    };
  }
  if ("system" in before && "system" in after) {
    const oldParts = new Map(systemParts(before.system).map((part) => [part.id, part]));
    const newParts = new Map(systemParts(after.system).map((part) => [part.id, part]));
    result.document.status = isDeepStrictEqual(before.system, after.system) ? "same" : "changed";
    result.document.sections = [...new Map([...oldParts, ...newParts]).values()]
      .filter((part) => !isDeepStrictEqual(oldParts.get(part.id), newParts.get(part.id)))
      .map((part) => part.name);
  }
  if (before.wire?.origin === "captured" && after.wire?.origin === "captured") {
    result.wire.bytes = before.wire.body === after.wire.body ? "same" : "changed";
    try {
      result.wire.json = isDeepStrictEqual(
        JSON.parse(before.wire.body),
        JSON.parse(after.wire.body),
      )
        ? "same"
        : "changed";
    } catch {
      // 字节比较仍有效;损坏或非 JSON 正文没有结构相等证据。
    }
  }
  return result;
}

export function textDifferenceLabel(difference: TextDifference): string {
  return `${difference.sameChars} of ${difference.oldChars} chars unchanged before first difference${difference.section ? ` · ${difference.section.name} char ${difference.section.char}` : ""}`;
}

/** 所有阅读入口共用范围说明,实际 usage 始终由调用方另行展示。 */
export function inputComparisonLines(comparison: InputComparison): string[] {
  const { text, document, tools, model, providerState, wire } = comparison;
  return [
    `Document: ${document.status === "unknown" ? "unknown" : document.status === "same" ? "unchanged" : `${document.sections.join(", ") || "structure"} changed`}`,
    `Message text: ${text.status === "same" ? "unchanged" : text.status}${text.first ? ` · message ${text.first.message + 1}: ${textDifferenceLabel(text.first)}` : text.status === "changed" ? ` after ${text.sameMessages} unchanged message texts` : ""}`,
    `Tool definitions: ${tools === "same" ? "unchanged" : tools === "unknown" ? "unknown (full definitions unavailable)" : tools}`,
    ...(model === "changed" ? ["Model: changed"] : []),
    ...(providerState === "changed"
      ? ["Replay state changed · wire impact is provider-dependent (markers, images or thinking)"]
      : []),
    `HTTP bytes: ${wire.bytes === "same" ? "unchanged" : wire.bytes} · JSON structure: ${wire.json === "same" ? "unchanged" : wire.json}${wire.bytes === "unknown" ? " (requires captured bodies for both inputs)" : ""}`,
  ];
}
