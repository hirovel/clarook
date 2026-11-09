// 工具描述风格槽:一份来源,按层拼接。每个工具的描述分三段(core / guidance / rules),
// 风格只决定拼到第几段:brief 只有 core,explain 加 guidance,rules 三段都要。用户可逐条覆盖。
// 描述没有最优解:各家的文案长短差一个量级,效果随模型而变,所以做成槽而不是定案。
// 内核不知道这一层;buildTools 装上,/toolprompts 会话中切换,切换记 session/slot 事件,下一次请求起生效。
import type { ToolPromptStyle, ToolPromptsConfig } from "../src/config.js";
import { toolDefinitionTokens } from "../src/context.js";
import { composeDescription, DESCRIPTION_LEVELS, type Tool } from "../src/tools.js";

export const TOOL_PROMPT_STYLES: ToolPromptStyle[] = DESCRIPTION_LEVELS;

/** 每种风格一句话,给 /toolprompts 列表用:说清多了哪一段。 */
export const STYLE_NOTES: Record<ToolPromptStyle, string> = {
  brief: "core only: what the tool does, its parameters and hard limits",
  explain:
    "core plus guidance: when to prefer another tool, failure causes, token-saving use (default)",
  rules: "explain plus imperative ALWAYS / NEVER rules on tool choice",
};

/** 没有分段的工具(扩展、MCP)第一次经手时记下原描述,以后切风格时用它。 */
const baseline = new WeakMap<Tool, string>();

export function baselineDescription(tool: Tool): string {
  const b = baseline.get(tool);
  if (b !== undefined) return b;
  baseline.set(tool, tool.description);
  return tool.description;
}

/** 某工具在某风格下的描述:用户改过的最优先,其次按分段拼接,没有分段的工具用原描述。 */
export function styledDescription(tool: Tool, cfg: ToolPromptsConfig | undefined): string {
  // 先记原描述:用户编辑后 reset 要能切回来,哪怕第一次经手就是带覆盖的调用。
  const base = baselineDescription(tool);
  const override = cfg?.descriptions?.[tool.name];
  if (override !== undefined) return override;
  return tool.describe ? composeDescription(tool.describe, cfg?.style ?? "explain") : base;
}

/** 原地换掉 tools 里每个工具的描述。返回描述变了的工具名。 */
export function applyToolPrompts(tools: Tool[], cfg: ToolPromptsConfig | undefined): string[] {
  const changed: string[] = [];
  for (const t of tools) {
    const next = styledDescription(t, cfg);
    if (next !== t.description) {
      t.description = next;
      changed.push(t.name);
    }
  }
  return changed;
}

/** /slots 与 session/slot 的值:风格名,加上改过的工具。 */
export function describeToolPrompts(cfg: ToolPromptsConfig | undefined): string {
  const style = cfg?.style ?? "explain";
  const edited = Object.keys(cfg?.descriptions ?? {});
  return edited.length === 0 ? style : `${style}, edited: ${edited.join(" ")}`;
}

/** 一套风格下全部工具定义的 token 估算(字符数 / 4),给 /toolprompts 的对照表。 */
export function styleTokens(tools: Tool[], cfg: ToolPromptsConfig | undefined): number {
  return toolDefinitionTokens(
    tools.map((t) => ({
      name: t.name,
      description: styledDescription(t, cfg),
      parameters: t.parameters,
    })),
  );
}

export function isToolPromptStyle(v: string): v is ToolPromptStyle {
  return (TOOL_PROMPT_STYLES as string[]).includes(v);
}
