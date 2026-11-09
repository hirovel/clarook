import { isDeepStrictEqual } from "node:util";
import type { AgentEvent } from "./events.js";
import type { Composition, Message } from "./messages.js";
import type { ToolDef } from "./provider.js";

type BaseComposition = (upTo: number) => Composition;
type Replay = { invalid: Set<number>; omittedAt: Map<number, number> };

/** 这里只识别回传物的种类;签名、模型与块编码仍归供应商。 */
function signedOpaque(opaque: unknown): boolean {
  return (
    typeof opaque === "object" &&
    opaque !== null &&
    (opaque as { kind?: unknown }).kind === "anthropic-thinking"
  );
}

function signed(message: Message): boolean {
  return message.role === "assistant" && signedOpaque(message.opaque);
}

function withoutSigned(message: Message): Message {
  if (!signed(message) || message.role !== "assistant") return message;
  const clean = { ...message };
  delete clean.opaque;
  return clean;
}

/** 仅忽略 Anthropic 签名回传物,其余结构一致时才能沿用标准投影的来源。 */
export function sameReplayShape(left: Message[], right: Message[]): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) =>
      isDeepStrictEqual(withoutSigned(message), withoutSigned(right[index] as Message)),
    )
  );
}

/** 省略只从首次实际清理请求之后生效,不能借后来事实改写它自己的输入。 */
export function applyToolOmissions(
  composition: Composition,
  omittedAt: ReadonlyMap<number, number>,
  upTo: number,
): Composition {
  const provenance = [...composition.provenance];
  const messages = composition.messages.map((message, index) => {
    const source = provenance[index];
    if (!source || (omittedAt.get(source.event) ?? upTo) >= upTo || !signed(message))
      return message;
    provenance[index] = { ...source, stages: [...source.stages, "opaque-dropped:tools"] };
    return withoutSigned(message);
  });
  return { ...composition, messages, provenance };
}

/**
 * 只从已有工具声明与实际请求输入派生。内部只调用基准投影,不会递归重建资格。
 * 未解决的旧块清掉后,无 body 的稳定请求无需再重建历史输入。
 */
export function toolReplay(
  events: readonly AgentEvent[],
  upTo: number,
  base: BaseComposition,
): Replay {
  const invalid = new Set<number>();
  const unresolved = new Set<number>();
  const omittedAt = new Map<number, number>();
  const sources: number[] = [];
  let definitions: readonly ToolDef[] | undefined;
  let lastKnown: readonly ToolDef[] | undefined;
  let dirty = false;
  let producerKnown = false;
  const change = (next: readonly ToolDef[]) => {
    if (lastKnown && !isDeepStrictEqual(lastKnown, next)) {
      for (const source of sources) {
        invalid.add(source);
        if (!omittedAt.has(source)) unresolved.add(source);
      }
    }
    definitions = next;
    lastKnown = next;
  };
  const projected = (before: number) => applyToolOmissions(base(before), omittedAt, before);
  for (let index = 0; index < upTo; index++) {
    const event = events[index];
    if (!event) continue;
    if (event.type === "tools/snapshot") {
      change(event.tools);
    } else if (event.type === "request") {
      dirty = false;
      producerKnown = false;
      if (event.reason === "compaction") continue;
      if (event.tools.length === 0) change([]);
      else if (
        definitions &&
        !isDeepStrictEqual(
          event.tools,
          definitions.map((tool) => tool.name),
        )
      )
        definitions = undefined;
      producerKnown = definitions !== undefined;
      if (invalid.size === 0 || (!event.body && unresolved.size === 0)) continue;
      const standard = projected(index);
      const actual = event.body
        ? [...projected(event.body.prefixEvents).messages, ...event.body.tail]
        : standard.messages;
      if (sameReplayShape(standard.messages, actual)) {
        for (let item = 0; item < actual.length; item++) {
          const source = standard.provenance[item]?.event;
          if (source === undefined || !invalid.has(source)) continue;
          if (signed(actual[item] as Message)) dirty = true;
          else if (event.body && !omittedAt.has(source)) {
            omittedAt.set(source, index);
            unresolved.delete(source);
          }
        }
      } else {
        // 自定义正文不变成永久上下文;这里只核对它是否仍携带已知失效的原回传物。
        dirty = actual.some(
          (message) =>
            signed(message) &&
            message.role === "assistant" &&
            [...invalid].some((source) => {
              const original = events[source];
              return (
                original?.type === "assistant/message" &&
                isDeepStrictEqual(original.opaque, message.opaque)
              );
            }),
        );
      }
    } else if (event.type === "request/error") {
      dirty = false;
      producerKnown = false;
    } else if (event.type === "assistant/message") {
      const generatedDirty = dirty;
      const known = producerKnown;
      dirty = false;
      producerKnown = false;
      // 缺生成请求或完整目录的旧块仍按旧规则回传,不能用后来快照补证。
      if (!known || !signedOpaque(event.opaque)) continue;
      sources.push(index);
      if (generatedDirty) {
        invalid.add(index);
        unresolved.add(index);
      }
    }
  }
  return { invalid, omittedAt };
}

/** 当前组装可改正文,但只能清掉与已知失效源相同的 Anthropic 回传物。 */
export function prepareReplay(
  events: readonly AgentEvent[],
  messages: Message[],
  invalid: ReadonlySet<number>,
): Message[] {
  if (invalid.size === 0) return messages;
  const originals = [...invalid].flatMap((source) => {
    const event = events[source];
    return event?.type === "assistant/message" ? [event.opaque] : [];
  });
  const originalSet = new Set(originals);
  const known = new Set(
    events.flatMap((event) => (event.type === "assistant/message" ? [event.opaque] : [])),
  );
  let changed = false;
  const prepared = messages.map((message) => {
    if (!signed(message) || message.role !== "assistant") return message;
    if (
      originalSet.has(message.opaque) ||
      (!known.has(message.opaque) &&
        originals.some((opaque) => isDeepStrictEqual(opaque, message.opaque)))
    ) {
      changed = true;
      return withoutSigned(message);
    }
    return message;
  });
  return changed ? prepared : messages;
}
