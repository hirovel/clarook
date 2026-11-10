// 会话与子任务共用资源装配;只共享连接,不共享工具闭包和日志包装。

import { now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { maxSteps, queueToTurnEnd, type TurnDeps } from "../src/loop.js";
import type { Provider } from "../src/provider.js";
import { errorMessage } from "../src/providers/errors.js";
import { recordSessionDirectory } from "../src/session-directory.js";
import type { ChildInfo, ChildTools, TaskSessions } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import type { CommonArgs } from "./args.js";
import {
  type bootstrap,
  buildCompaction,
  buildTools,
  loadExtensions,
  memoryFiles,
  resolveToolPrompts,
} from "./bootstrap.js";
import { connectMcpServers, type McpBridge } from "./mcp/bridge.js";
import { loadMcpServers, mcpConfigOf } from "./mcp/config.js";
import { McpConnections } from "./mcp/connections.js";
import {
  type ProjectMcpReview,
  projectMcpReview,
  projectMcpTrusted,
  trustProjectMcp,
} from "./mcp/trust.js";
import { automaticSkills, discoverSkills, type Skill } from "./prompt.js";
import { type DirectoryIssue, prepareSessionDirectory } from "./session-directory.js";
import { applyToolPrompts } from "./tool-prompts.js";
import { createSkillTool, skillCatalog } from "./tools/skill.js";

export async function prepareSessionRuntime(options: {
  boot: ReturnType<typeof bootstrap>;
  args: CommonArgs;
  sessions: TaskSessions;
  sessionFile: string;
  /** 新建时与初稿共享同次发现;恢复时按保存的配置重新准备能力。 */
  skills?: Skill[];
  entryCwd?: string;
  directory?: string;
  chooseDirectory?: (issue: DirectoryIssue) => Promise<string | undefined>;
  connections?: McpConnections;
  onChild?: (child: ChildInfo) => void;
  onLog?: (log: EventLog) => void;
  slots?: () => TurnDeps["slots"];
  current?: () => { provider: Provider; modelLocator: string; tools: readonly Tool[] } | undefined;
  allowUnavailable?: boolean;
  descriptions?: Record<string, string>;
  confirmProjectMcp?: (review: ProjectMcpReview) => Promise<boolean>;
}) {
  const { boot, args, sessions } = options;
  const log = sessions.log;
  const directory = await prepareSessionDirectory(log, {
    entryCwd: options.entryCwd ?? process.cwd(),
    ...(options.directory !== undefined && { directory: options.directory }),
    ...(options.chooseDirectory && { chooseDirectory: options.chooseDirectory }),
  });
  if (!directory) return undefined;
  const { cwd } = directory;
  const choice = options.allowUnavailable ? boot.chooseOrNone(args.model) : boot.choose(args.model);
  const compaction = await buildCompaction(args, choice.contextWindow, cwd);
  const memory = args.memory ? memoryFiles(cwd) : undefined;
  const skills =
    options.skills ??
    discoverSkills(cwd, {
      ...(args.skillsSources && { sources: args.skillsSources }),
      onError: (error) =>
        log.append({
          type: "ext/event",
          at: now(),
          source: "skills",
          kind: "load-error",
          payload: { message: error.message },
        }),
    });
  const toolPrompts = resolveToolPrompts(args, boot.config);
  if (options.descriptions) toolPrompts.descriptions = options.descriptions;
  const connections = options.connections ?? new McpConnections();
  const config = mcpConfigOf(boot.config.mcp);
  const projectReview = projectMcpReview(cwd);
  const allServers = loadMcpServers(config, cwd, process.env, projectReview?.snapshot ?? null);
  const projectNames = new Set(
    allServers
      .filter((server) => server.source === projectReview?.file)
      .map((server) => server.name),
  );
  const review = projectReview && {
    ...projectReview,
    servers: projectReview.servers.filter((server) => projectNames.has(server.name)),
  };
  let useProjectMcp = true;
  if (review?.servers.length && !projectMcpTrusted(review)) {
    if (!options.confirmProjectMcp)
      throw new Error(
        `Project MCP is not trusted: ${review.file}. Open Clarook TUI to review and approve it; no project MCP command was started.`,
      );
    useProjectMcp = await options.confirmProjectMcp(review);
    if (useProjectMcp) {
      trustProjectMcp(review);
      log.append({
        type: "ext/event",
        at: now(),
        source: "mcp",
        kind: "project-trusted",
        payload: { file: review.file },
      });
    }
  }
  const servers = allServers.filter((server) => useProjectMcp || server.source !== review?.file);
  if (review && projectMcpReview(cwd)?.digest !== review.digest)
    throw new Error(
      `${review.file} changed during preparation; inspect it again before connecting`,
    );
  if (review?.servers.length && !useProjectMcp)
    log.append({
      type: "ext/event",
      at: now(),
      source: "mcp",
      kind: "project-skipped",
      payload: { file: review.file },
    });

  async function assemble(target: EventLog, reconnect = false) {
    const ext = await loadExtensions(args.extensions, { cwd, log: target });
    let mcp: McpBridge | undefined;
    let disposing: Promise<void> | undefined;
    const dispose = (): Promise<void> =>
      (disposing ??= (async () => {
        const results = await Promise.allSettled([
          ext.dispose(),
          mcp?.close() ?? Promise.resolve(),
        ]);
        const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
        if (errors.length) throw new AggregateError(errors, "Session resource cleanup failed");
      })());
    try {
      const base = buildTools({
        cwd,
        ...(memory && { memory }),
        ...(args.skillsLoad === "tool" && {
          skills: automaticSkills(skills, {
            ...(args.skillsMode && { mode: args.skillsMode }),
            ...(args.skillsInclude !== undefined && { include: args.skillsInclude }),
          }),
        }),
        ...(boot.config.fetch && { fetchConfig: boot.config.fetch }),
        toolPrompts,
        plan: args.plan ?? true,
      });
      const tools = [
        ...base.filter((t) => !ext.tools?.some((e) => e.name === t.name)),
        ...(ext.tools ?? []),
      ];
      mcp = await connectMcpServers(servers, {
        log: target,
        tools,
        connections,
        activate: false,
        ...(target.path && { artifactsDir: target.path.replace(/\.jsonl$/, ".mcp") }),
        ...(config && { mcp: config }),
        ...(reconnect && args.mcpReconnect && { reconnect: args.mcpReconnect }),
      });
      // 子任务可独立恢复;只在其资源准备成功后记录实际使用的同一根。
      if (target !== log) recordSessionDirectory(target, cwd);
      return { tools, mcp, slots: ext.slots, dispose };
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Session initialization failed: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }
  const disposeOwned = async (dispose: () => Promise<void>): Promise<void> => {
    const errors: unknown[] = [];
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
    if (!options.connections) {
      try {
        await connections.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Session resource cleanup failed");
  };
  let root: Awaited<ReturnType<typeof assemble>>;
  try {
    root = await assemble(log, true);
  } catch (error) {
    if (!options.connections) {
      try {
        await connections.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Session initialization and cleanup failed",
        );
      }
    }
    throw error;
  }
  try {
    const slots: TurnDeps["slots"] = {
      ...root.slots,
      ...(args.maxSteps !== undefined && { termination: maxSteps(args.maxSteps) }),
      ...(args.execution && { execution: args.execution }),
      ...(args.steering === "turn" && { steering: queueToTurnEnd }),
    };
    const current = () =>
      options.current?.() ?? {
        provider: choice.provider,
        modelLocator: `${choice.providerName}/${choice.model}`,
        tools: root.tools.filter((t) => !args.disabledTools?.includes(t.name)),
      };
    if (args.subagent && !root.tools.some((t) => t.name === "task")) {
      const task = sessions.tool({
        ...boot.config.subagents,
        ...(args.subagentMaxSteps != null && { maxSteps: args.subagentMaxSteps }),
        ...(args.subagentDepth !== undefined && { depth: args.subagentDepth }),
        cwd,
        provider: () => current().provider,
        modelLocator: () => current().modelLocator,
        tools: (childLog) => {
          // 初始化前固定名称与描述;执行闭包由 assemble 重新创建。
          const enabled = current().tools;
          const selected = new Map(enabled.map((t) => [t.name, t.description]));
          const selectedSkill = enabled.find((t) => t.name === "skill");
          const catalog = selectedSkill && skillCatalog(selectedSkill);
          const fork = async (target: EventLog): Promise<ChildTools> => {
            const resources = await assemble(target);
            // 目录也随派发固定;不能用父会话启动时的旧范围重新装配。
            const tools = resources.tools.filter((t) => !skillCatalog(t));
            if (catalog) tools.push(createSkillTool([...catalog]));
            return {
              tools: tools
                .filter((t) => selected.has(t.name))
                .map((t) => ({
                  ...t,
                  description: selected.get(t.name) ?? t.description,
                })),
              dispose: resources.dispose,
              fork,
              ...(resources.slots?.beforeToolCall && {
                beforeToolCall: resources.slots.beforeToolCall,
              }),
              ...(resources.slots?.afterToolCall && {
                afterToolCall: resources.slots.afterToolCall,
              }),
            };
          };
          return fork(childLog);
        },
        compaction,
        providerFor: (model) => {
          const selected = boot.choose(model);
          return {
            provider: selected.provider,
            modelLocator: `${selected.providerName}/${selected.model}`,
          };
        },
        ...(options.onChild && { onChild: options.onChild }),
        ...(options.onLog && { onLog: options.onLog }),
        slots: () => options.slots?.() ?? slots,
      });
      applyToolPrompts([task], toolPrompts);
      root.tools.push(task);
    }
    return {
      sessions,
      cwd,
      choice,
      compaction,
      tools: root.tools,
      slots,
      mcp: root.mcp,
      memory,
      skills,
      toolPrompts,
      activate: () => {
        root.mcp.activate();
        directory.commit();
      },
      // runtime只是这一代执行资源;日志节点由Session跨代持有,宿主最后保存释放。
      dispose: () => disposeOwned(root.dispose),
    };
  } catch (error) {
    try {
      await disposeOwned(root.dispose);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Session initialization failed: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}
