import type { AgentEvent } from "./events.js";

/** 段身份与正文一起入日志;渲染出的全文不再反过来承担来源身份。 */
export type SystemSection = {
  id: string;
  name: string;
  text: string;
  enabled: boolean;
  source?: string;
};

/** 原生自定义正文或明确分段;两者都直接表达内容,不从字符数恢复结构。 */
export type SystemPrompt = string | SystemSection[];

export function systemText(prompt: SystemPrompt | undefined): string {
  if (typeof prompt === "string") return prompt;
  return (prompt ?? [])
    .filter((section) => section.enabled && section.text.length > 0)
    .map((section) => section.text)
    .join("\n\n");
}

export function systemParts(prompt: SystemPrompt | undefined): readonly SystemSection[] {
  if (prompt === undefined) return [];
  return typeof prompt === "string"
    ? [{ id: "custom", name: "Custom", text: prompt, enabled: true }]
    : prompt;
}

/** 当前与历史请求共用同一时点查询;后续编辑不能改写旧请求的段身份。 */
export function systemAt(
  events: readonly AgentEvent[],
  upTo = events.length,
): SystemPrompt | undefined {
  let target = -1;
  let prompt: SystemPrompt | undefined;
  for (let i = 0; i < Math.min(upTo, events.length); i++) {
    const event = events[i];
    if (event?.type === "session/start" && target < 0) {
      target = i;
      prompt = event.system;
    } else if (
      event?.type === "context/edit" &&
      event.target === target &&
      event.field === "system"
    ) {
      prompt = event.value;
    }
  }
  return prompt;
}
