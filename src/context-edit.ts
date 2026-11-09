import { isDeepStrictEqual } from "node:util";
import { type AgentEvent, now } from "./events.js";
import type { EventLog } from "./log.js";
import {
  type Composition,
  compactionState,
  composeContext,
  editState,
  type Message,
  userShellText,
} from "./messages.js";
import { type SystemPrompt, type SystemSection, systemParts } from "./system-prompt.js";

export type EditField = Extract<AgentEvent, { type: "context/edit" }>["field"];
/** 数字指原事件;message 指当前投影的下标,合成摘要的操作语义由本 module 解释。 */
export type ContextTarget = number | { message: number };
export type ContextAction =
  | "edit"
  | "edit-reasoning"
  | "compare"
  | "restore"
  | "drop"
  | "rewind"
  | "retry"
  | "toggle-section";
export type ContextAccess = { running?: boolean; readOnlyReason?: string };
export type ContextField = {
  field: EditField;
  original: string;
  current: string;
  edited: boolean;
  readOnlyReason?: string;
  section?: string;
  name?: string;
  enabled?: boolean;
  source?: string;
};
export type ContextComparison =
  | { field: "system"; original: SystemPrompt; current: SystemPrompt }
  | { field: Exclude<EditField, "system">; original: string; current: string };
export type ContextEffect = {
  target: number;
  fields: EditField[];
  /** 实际写入 drop 的目标;关联结果由投影规则一并排除。 */
  dropped: number[];
  /** 当前输入中实际移除的消息,包含属于被排除调用的工具结果。 */
  removed: { event: number; message: Message }[];
  opaqueDiscarded: boolean;
  /** 当前输入中最早受影响的下标;供应商回传策略由宿主解释。 */
  prefixFrom?: number;
};
export type ContextView = {
  composition: Composition;
  target?: number;
  fields: ContextField[];
  /** 比较保留文档事实;当前可编辑字段不能表达被删除的段与启用状态。 */
  comparisons: ContextComparison[];
  actions: ContextAction[];
  restrictions: Partial<Record<ContextAction, string>>;
  effects: Partial<Record<ContextAction, ContextEffect>>;
};
export type ContextOperation =
  | {
      type: "edit";
      target: ContextTarget;
      field?: EditField;
      section?: string;
      value: string;
      note?: string;
    }
  | { type: "restore" | "rewind"; target: ContextTarget }
  | { type: "drop"; target: ContextTarget; note?: string }
  | { type: "retry" }
  | { type: "toggle-section"; target: ContextTarget; section: string }
  | { type: "replace-section"; target: ContextTarget; id: string; section?: SystemSection }
  | { type: "set-system"; target: ContextTarget; value: SystemPrompt; note?: string };

type Change = Extract<AgentEvent, { type: "context/edit" | "context/drop" }>;
type Plan = { writes: Change[]; effect: ContextEffect };

/** 字段事实不出 module;调用者不必认识不同事件正文与思考的持久表达。 */
function contextFields(
  event: AgentEvent | undefined,
  edits: Partial<{ system: SystemPrompt; text: string; reasoning: string; content: string }> = {},
): ContextField[] {
  const field = (
    name: Exclude<EditField, "system">,
    original: string,
    readOnlyReason?: string,
  ): ContextField => ({
    field: name,
    original,
    current: edits[name] ?? original,
    edited: edits[name] !== undefined,
    ...(readOnlyReason && { readOnlyReason }),
  });
  switch (event?.type) {
    case "session/directory":
      return [
        {
          field: "content",
          original: event.environment,
          current: event.environment,
          edited: false,
          readOnlyReason:
            "Session directory is an execution fact; use /session directory to change it.",
        },
      ];
    case "assistant/message":
      return [
        field("text", event.text),
        field(
          "reasoning",
          event.reasoning ?? "",
          event.reasoningKind === "full"
            ? undefined
            : `thinking is ${event.reasoningKind === "summary" ? "a summary" : "of unknown kind"}: the model reads the opaque block, so editing it changes nothing. To steer, append a message, or use a model that echoes full thinking (DeepSeek)`,
        ),
      ];
    case "user/message":
      return [field("content", event.text)];
    case "user/shell":
      return event.excludeFromContext ? [] : [field("content", userShellText(event))];
    case "tool/result":
    case "tool/unresolved":
      return [field("content", event.content)];
    case "session/start": {
      const original = systemParts(event.system);
      return systemParts(edits.system ?? event.system).map((section) => ({
        field: "system",
        section: section.id,
        name: section.name,
        enabled: section.enabled,
        ...(section.source && { source: section.source }),
        original: original.find((part) => part.id === section.id)?.text ?? "",
        current: section.text,
        edited: edits.system !== undefined,
      }));
    }
    default:
      return [];
  }
}

function droppable(event: AgentEvent | undefined): boolean {
  return (
    event?.type === "user/message" ||
    event?.type === "assistant/message" ||
    (event?.type === "user/shell" && !event.excludeFromContext)
  );
}

function checkSections(prompt: SystemPrompt): void {
  if (typeof prompt === "string") return;
  const ids = new Set<string>();
  for (const section of prompt) {
    if (!section.id.trim()) throw new Error("System section id cannot be empty");
    if (ids.has(section.id)) throw new Error(`Duplicate system section id: ${section.id}`);
    ids.add(section.id);
  }
}

function evaluate(
  events: readonly AgentEvent[],
  selection?: ContextTarget,
  access: ContextAccess = {},
): { view: ContextView; plans: Partial<Record<ContextAction, Plan>> } {
  const composition = composeContext(events);
  const state = editState(events);
  const row =
    typeof selection === "object" && Number.isInteger(selection.message)
      ? composition.provenance[selection.message]
      : undefined;
  const target = typeof selection === "number" ? selection : row?.event;
  const event = target === undefined ? undefined : events[target];
  const edits = target === undefined ? undefined : state.edits.get(target);
  const system = event?.type === "session/start" ? (edits?.system ?? event.system) : undefined;
  const fields = contextFields(event, edits);
  const comparisons: ContextComparison[] =
    event?.type === "session/start" && edits?.system !== undefined
      ? [{ field: "system", original: event.system, current: edits.system }]
      : fields.flatMap((field): ContextComparison[] =>
          field.field !== "system" && field.edited
            ? [{ field: field.field, original: field.original, current: field.current }]
            : [],
        );
  const view: ContextView = {
    composition,
    ...(target !== undefined && { target }),
    fields,
    comparisons,
    actions: [],
    restrictions: {},
    effects: {},
  };
  const plans: Partial<Record<ContextAction, Plan>> = {};
  const unavailable =
    access.readOnlyReason || (access.running && "cannot edit while running; press Esc first");
  const missing =
    target === undefined || !Number.isInteger(target) || !event
      ? `no event #${target ?? "?"} (${events.length} events; Ctrl+E shows event numbers)`
      : undefined;
  const omitted = composition.omitted.find((item) => item.event === target);
  const projected = composition.provenance.some((item) => item.event === target);
  const restriction =
    missing ||
    (omitted?.reason === "covered"
      ? `event #${target} is in compacted history; changing its original does not change the summary`
      : omitted?.reason === "dropped"
        ? `event #${target} is excluded from current input; its original stays in history`
        : composition.provenance.some(
              (item) => item.event === target && item.stages.includes("cleared"),
            )
          ? `event #${target} was cleared from current input; changing its original does not replace the placeholder`
          : !projected
            ? `event #${target} is ${event?.type}; it never reaches the model, nothing to edit`
            : undefined);
  const mutationRestriction = unavailable || restriction;
  const makePlan = (resolved: number, writes: Change[]): Plan => {
    const dropped = writes
      .filter((item) => item.type === "context/drop")
      .map((item) => item.target);
    const excluded = dropped.length ? editState([...events, ...writes]).dropped : new Set<number>();
    const removed = composition.provenance.flatMap((item, i) =>
      excluded.has(item.event)
        ? [{ event: item.event, message: composition.messages[i] as Message }]
        : [],
    );
    const affected = composition.provenance.findIndex((item) =>
      dropped.length ? excluded.has(item.event) : item.event === resolved,
    );
    const message = composition.messages[affected];
    return {
      writes,
      effect: {
        target: resolved,
        fields: writes.flatMap((item) => (item.type === "context/edit" ? [item.field] : [])),
        dropped,
        removed,
        opaqueDiscarded:
          !dropped.length && message?.role === "assistant" && message.opaque !== undefined,
        ...(affected >= 0 && { prefixFrom: affected }),
      },
    };
  };
  const offer = (
    action: ContextAction,
    reason: string | false | undefined,
    createPlan?: () => Plan | undefined,
  ) => {
    if (reason) view.restrictions[action] = reason;
    else {
      view.actions.push(action);
      const plan = createPlan?.();
      if (plan) {
        plans[action] = plan;
        view.effects[action] = plan.effect;
      }
    }
  };
  const editPlan = (field: ContextField | undefined): Plan | undefined => {
    if (target === undefined) return undefined;
    if (system !== undefined)
      return makePlan(target, [
        { type: "context/edit", at: "", target, field: "system", value: system },
      ]);
    if (!field || field.field === "system") return undefined;
    return makePlan(target, [
      { type: "context/edit", at: "", target, field: field.field, value: field.current },
    ]);
  };
  const main = fields[0];
  offer(
    "edit",
    mutationRestriction ||
      (main?.readOnlyReason && `event #${target} ${main.readOnlyReason}`) ||
      (!main &&
        system === undefined &&
        `event #${target} is ${event?.type}; it never reaches the model, nothing to edit`),
    () => editPlan(main),
  );
  offer(
    "toggle-section",
    mutationRestriction ||
      (system === undefined && `event #${target} has no system sections`) ||
      (!fields.length && `event #${target} has no system sections`),
    () => editPlan(main),
  );
  const reasoning = fields.find((field) => field.field === "reasoning");
  offer(
    "edit-reasoning",
    mutationRestriction ||
      (reasoning?.readOnlyReason && `event #${target} ${reasoning.readOnlyReason}`) ||
      (!reasoning && `event #${target} has no field reasoning`),
    () => editPlan(reasoning),
  );
  const edited = fields.filter((field) => field.edited);
  const hasEdits = comparisons.length > 0;
  const noEdits = !hasEdits && `event #${target} has no edits; nothing to restore`;
  offer("compare", missing || (!hasEdits && `event #${target} has no edits; nothing to compare`));
  offer(
    "restore",
    mutationRestriction || noEdits || edited.find((field) => field.readOnlyReason)?.readOnlyReason,
    () =>
      target === undefined
        ? undefined
        : makePlan(
            target,
            event?.type === "session/start"
              ? [
                  {
                    type: "context/edit",
                    at: "",
                    target,
                    field: "system",
                    value: event.system,
                    note: "restore",
                  },
                ]
              : edited.flatMap((field): Change[] =>
                  field.field === "system"
                    ? []
                    : [
                        {
                          type: "context/edit",
                          at: "",
                          target,
                          field: field.field,
                          value: field.original,
                          note: "restore",
                        },
                      ],
                ),
          ),
  );
  offer(
    "drop",
    mutationRestriction ||
      (!droppable(event) &&
        `only user or assistant messages can be dropped (with their tool results); #${target} is ${event?.type}`),
    () =>
      target === undefined
        ? undefined
        : makePlan(target, [{ type: "context/drop", at: "", target }]),
  );
  const compacted = compactionState(events);
  const rewindRestriction =
    unavailable ||
    missing ||
    (row?.stages.some((stage) => stage.startsWith("summary")) &&
      "cannot rewind to a summary row: its source event follows retained messages") ||
    (compacted.summary &&
      target !== undefined &&
      target < compacted.coversUpTo - 1 &&
      `cannot rewind to event #${target}: compacted history includes later messages; the summary is kept`);
  // 只排除当前投影中的消息;目录事实、已覆盖与已排除内容不会被重复写成 drop。
  const victims = composition.provenance
    .map((item) => item.event)
    .filter((index) => target !== undefined && index > target && droppable(events[index]));
  offer(
    "rewind",
    rewindRestriction || (!victims.length && `nothing after event #${target} to drop`),
    () =>
      target === undefined
        ? undefined
        : makePlan(
            target,
            victims.map((index) => ({
              type: "context/drop",
              at: "",
              target: index,
              note: `rewind to #${target}`,
            })),
          ),
  );
  let latest: number | undefined;
  for (let i = composition.messages.length - 1; i >= 0; i--) {
    if (composition.messages[i]?.role === "assistant") {
      latest = composition.provenance[i]?.event;
      break;
    }
  }
  offer(
    "retry",
    unavailable || (latest === undefined && "no assistant message to retry in current context"),
    () =>
      latest === undefined
        ? undefined
        : makePlan(latest, [{ type: "context/drop", at: "", target: latest, note: "retry" }]),
  );
  view.fields = fields.map((field) => {
    const readOnlyReason = mutationRestriction || field.readOnlyReason;
    return { ...field, ...(readOnlyReason && { readOnlyReason }) };
  });
  return { view, plans };
}

/** 当前投影、字段、资格和实际影响共同从事件事实生成;宿主仅传临时访问条件。 */
export function contextView(
  events: readonly AgentEvent[],
  target?: ContextTarget,
  access?: ContextAccess,
): ContextView {
  return evaluate(events, target, access).view;
}

/** 保存时重新判断当前事实,与菜单共用规则;拒绝操作不会追加事件。 */
export function changeContext(
  log: EventLog,
  operation: ContextOperation,
  access?: ContextAccess,
): ContextEffect {
  const { view, plans } = evaluate(
    log.events,
    operation.type === "retry" ? undefined : operation.target,
    access,
  );
  const action =
    operation.type === "edit" && operation.field === "reasoning"
      ? "edit-reasoning"
      : operation.type === "set-system" || operation.type === "replace-section"
        ? "edit"
        : operation.type;
  let plan = plans[action];
  if (operation.type === "edit") {
    const field = operation.section
      ? view.fields.find((item) => item.field === "system" && item.section === operation.section)
      : operation.field
        ? view.fields.find((item) => item.field === operation.field)
        : view.fields[0];
    if (!field && view.fields.length)
      throw new Error(
        operation.section
          ? `event #${view.target} has no system section ${operation.section}`
          : `event #${view.target} has no field ${operation.field}; editable: ${view.fields
              .filter((item) => !item.readOnlyReason)
              .map((item) => item.field)
              .join(" / ")}`,
      );
    if (field?.readOnlyReason)
      throw new Error(view.restrictions[action] || `event #${view.target} ${field.readOnlyReason}`);
  }
  if (!plan) throw new Error(view.restrictions[action] || "Context action is unavailable");
  const systemChange = plan.writes.find(
    (item) => item.type === "context/edit" && item.field === "system",
  );
  if (
    operation.type === "set-system" ||
    operation.type === "replace-section" ||
    operation.type === "toggle-section" ||
    (operation.type === "edit" && systemChange)
  ) {
    if (systemChange?.type !== "context/edit" || systemChange.field !== "system")
      throw new Error(`event #${view.target} has no system sections`);
    let value: SystemPrompt;
    if (operation.type === "set-system") value = operation.value;
    else {
      const sections = systemParts(systemChange.value);
      if (operation.type === "replace-section") {
        if (operation.section && operation.section.id !== operation.id)
          throw new Error("Replacement section id must match the selected id");
        const existing = sections.find((section) => section.id === operation.id);
        value = sections.flatMap((section) =>
          section.id !== operation.id
            ? [section]
            : operation.section
              ? [{ ...operation.section, enabled: section.enabled }]
              : [],
        );
        if (!existing && operation.section) value.push(operation.section);
      } else {
        if (!operation.section) throw new Error("Choose a system section to edit");
        if (!sections.some((section) => section.id === operation.section))
          throw new Error(`event #${view.target} has no system section ${operation.section}`);
        value = sections.map((section) =>
          section.id !== operation.section
            ? section
            : operation.type === "toggle-section"
              ? { ...section, enabled: !section.enabled }
              : { ...section, text: operation.value },
        );
      }
    }
    checkSections(value);
    if (
      (operation.type === "replace-section" || operation.type === "set-system") &&
      isDeepStrictEqual(value, systemChange.value)
    )
      return {
        target: plan.effect.target,
        fields: [],
        dropped: [],
        removed: [],
        opaqueDiscarded: false,
      };
    plan = {
      ...plan,
      writes: [
        {
          ...systemChange,
          value,
          ...("note" in operation && operation.note && { note: operation.note }),
        },
      ],
    };
  } else if (operation.type === "edit") {
    plan = {
      ...plan,
      writes: plan.writes.map((item) =>
        item.type === "context/edit" && item.field !== "system"
          ? { ...item, value: operation.value, ...(operation.note && { note: operation.note }) }
          : item,
      ),
    };
  }
  for (const write of plan.writes)
    log.append({
      ...write,
      at: now(),
      ...(operation.type === "drop" && operation.note && { note: operation.note }),
    });
  return plan.effect;
}
