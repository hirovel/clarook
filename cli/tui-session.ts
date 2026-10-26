import { resolve } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { DEFAULT_APPROVAL } from "../src/approval.js";
import type { Preset } from "../src/config.js";
import { now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import { errorMessage } from "../src/providers/errors.js";
import { recordUnresolvedCalls } from "../src/recovery.js";
import { applyPreset, type CommonArgs, parseCommonArgs, settingsFromArgs } from "./args.js";
import {
  type Bootstrap,
  beginSession,
  openSession,
  RESERVE,
  resolveApproval,
  sessionsDir,
  systemPromptFor,
} from "./bootstrap.js";
import { McpConnections } from "./mcp/connections.js";
import type { ProjectMcpReview } from "./mcp/trust.js";
import { SessionInputs } from "./session-inputs.js";
import { prepareSessionRuntime } from "./session-runtime.js";
import {
  recordSessionSetup,
  restoreSessionSetup,
  type SessionSetup,
  withCurrentDisplay,
} from "./session-setup.js";
import type { ExitState } from "./session-view.js";
import { discoverTemplates } from "./templates.js";
import { createTuiApp, type TuiApp } from "./tui-app.js";
import type { SessionTarget } from "./tui-context.js";

type Session = ReturnType<typeof openSession>;
type Runtime = Awaited<ReturnType<typeof prepareSessionRuntime>>;

export async function startTuiSession(options: {
  boot: Bootstrap;
  args: CommonArgs;
  terminal: () => Terminal;
  onExit: () => void;
}) {
  const { boot } = options;
  const dir = sessionsDir(boot.config);
  const connections = new McpConnections();
  const inputs = new Map<string, SessionInputs>();
  // 离开的会话只有尚未保存时留在这里;恢复写盘即释放,重开时复用同一个写入者。
  const unsaved = new Map<string, EventLog>();
  const retainUnsaved = (log: EventLog) => {
    const store = log.recording;
    if (!store?.error || !log.path) return;
    const key = resolve(log.path);
    if (unsaved.has(key)) return;
    unsaved.set(key, log);
    const off = store.subscribe(() => {
      if (!store.error) {
        unsaved.delete(key);
        off();
        if (current?.session.log !== log) store.dispose();
      }
    });
  };
  const releaseSessionLog = (log: EventLog) => {
    if (log === current.session.log) return;
    log.recording?.flush();
    retainUnsaved(log);
    if (!log.recording?.error) log.recording?.dispose();
  };

  const first = boot.chooseOrNone(options.args.model);
  let switching = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let failure: string | undefined;
  let exitState: ExitState | undefined;
  let exitRequested = false;
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    options.onExit();
  };
  let current: {
    session: Session;
    args: CommonArgs;
    view: TuiApp;
    runtime?: Runtime;
    binding?: { view?: TuiApp };
  };
  let trustView: TuiApp | undefined;
  const argsFor = (values: Preset) =>
    applyPreset(parseCommonArgs([]), {
      ...boot.config,
      defaults: values,
      presets: {},
      prompt: values.prompt ?? {},
    });
  const defaults = (): SessionSetup => {
    const args = boot.resolve(parseCommonArgs([]));
    const values = {
      ...settingsFromArgs(args),
      extensions: args.extensions,
      model: args.model ?? boot.config.default,
      approval: args.approval ?? boot.config.approval ?? DEFAULT_APPROVAL,
    };
    return { values, tools: [], descriptions: boot.config.toolPrompts?.descriptions ?? {} };
  };
  const prepareView = (session: Session, args: CommonArgs, runtime?: Runtime): (() => TuiApp) => {
    const choice = runtime?.choice ?? first;
    const templateErrors: string[] = [];
    const templates = discoverTemplates(process.cwd(), undefined, (error) =>
      templateErrors.push(error.message),
    );
    let savedInputs: SessionInputs | undefined;
    if (runtime) {
      savedInputs = inputs.get(session.sessionFile);
      if (!savedInputs) {
        savedInputs = new SessionInputs(session.sessionFile, args.saveInputs ?? true);
        inputs.set(session.sessionFile, savedInputs);
      } else if (savedInputs.saving !== (args.saveInputs ?? true))
        savedInputs.configure(args.saveInputs ?? true);
    }
    const snapshot = savedInputs?.read(session.log.events);
    const terminal = options.terminal();
    return () => {
      const view = createTuiApp(
        {
          ...(savedInputs && { inputs: savedInputs }),
          saveInputs: args.saveInputs ?? true,
          terminal,
          log: session.log,
          provider: choice.provider,
          tools: runtime?.tools ?? [],
          compaction: runtime?.compaction ?? {
            strategy: async () => null,
            window: choice.contextWindow,
          },
          reserveTokens: args.compactionReserve ?? RESERVE,
          info: {
            model: choice.model,
            providerName: choice.providerName,
            sessionFile: session.sessionFile,
            resumed: session.resumed,
            contextWindow: choice.contextWindow,
            ...(choice.capabilitySource && { capabilitySource: choice.capabilitySource }),
          },
          settings: { ...boot.settings, settingLayers: () => ({ defaults: boot.config.defaults }) },
          startupSettings: {
            ...settingsFromArgs(args),
            extensions: args.extensions,
            ...(args.systemPromptFile && { systemPromptFile: args.systemPromptFile }),
            ...(args.appendSystemPromptFile && {
              appendSystemPromptFile: args.appendSystemPromptFile,
            }),
          },
          fold: args.fold,

          ...(args.foldLines !== undefined && { foldLines: args.foldLines }),
          ...(args.foldSteps !== undefined && { foldSteps: args.foldSteps }),
          ...(args.statusStyle && { statusStyle: args.statusStyle }),
          ...(args.statusWidgets && { statusWidgets: args.statusWidgets }),
          showCostEstimate: args.showCostEstimate ?? false,
          ...(args.results && { results: args.results }),
          ...(args.facts && { facts: args.facts }),
          ...(args.planReminder !== undefined && { planReminder: args.planReminder }),
          ...(args.disabledTools && { disabledTools: args.disabledTools }),
          ...(args.mcpReconnect && { mcpReconnect: args.mcpReconnect }),
          ...(args.screen && { screen: args.screen }),
          ...(args.notify && { notify: args.notify }),
          approve: resolveApproval(args, boot.config),
          compactionName: args.compaction,
          ...(args.preservation && { preservationSpec: args.preservation }),
          ...(args.effort && { effort: args.effort }),
          ...(choice.effortLevels && { effortLevels: choice.effortLevels }),
          ...(choice.price && { price: choice.price }),
          ...(runtime
            ? {
                slots: runtime.slots,
                mcp: runtime.mcp,
                skills: runtime.skills,
                toolPrompts: runtime.toolPrompts,
                ...(runtime.memory && { memory: runtime.memory }),
                ...(choice.unavailable && { unavailable: choice.unavailable }),
                onSetupChange: (setup: SessionSetup) => recordSessionSetup(session.log, setup),
              }
            : {
                readOnlyReason:
                  "History is open for review. Choose /session resume to prepare its setup before running.",
              }),
          templates,
          sessionsDir: dir,
          switchSession: (target) => {
            void switchSession(target).catch((error) =>
              current.view.note(`Session switch failed: ${errorMessage(error)}`),
            );
          },
          onExit: () => {
            if (exitRequested) return;
            exitRequested = true;
            void close()
              .then(exit)
              .catch((error) => {
                exitRequested = false;
                current.view.note(`Could not close: ${errorMessage(error)}`);
              });
          },
        },
        snapshot,
      );
      for (const error of templateErrors) view.note(error);
      return view;
    };
  };
  async function prepare(
    session: Session,
    args: CommonArgs,
    setup?: SessionSetup,
    allowUnavailable = false,
  ) {
    const binding: { view?: TuiApp } = {};
    const runtime = await prepareSessionRuntime({
      boot,
      args,
      ...session,
      connections,
      allowUnavailable,
      onChild: (child) => binding.view?.attachChild(child),
      slots: () => binding.view?.slots(),
      current: () =>
        binding.view && {
          provider: binding.view.agent.provider,
          tools: binding.view.agent.tools,
        },
      ...(setup?.descriptions && { descriptions: setup.descriptions }),
      confirmProjectMcp: async (review: ProjectMcpReview) => {
        let view = current?.view;
        if (!view) {
          trustView = prepareView(session, args)();
          view = trustView;
          current = { session, args, view };
        }
        await view.showText(
          "Project MCP configuration",
          [
            `Source: ${review.file}`,
            "This file can start local processes or contact remote servers when the session connects.",
            "Trust is saved for this project path and this exact file content. Changes require review again.",
            "",
            ...review.servers.flatMap((server) => [
              server.name,
              ...(server.command ? [`  command: ${server.command}`] : []),
              ...(server.args?.length
                ? ["  args:", ...server.args.map((arg, index) => `    ${index + 1}. ${arg}`)]
                : []),
              ...(server.cwd ? [`  cwd: ${server.cwd}`] : []),
              ...(server.url ? [`  url: ${server.url}`] : []),
              ...(server.envKeys?.length ? [`  env keys: ${server.envKeys.join(", ")}`] : []),
              ...(server.headerKeys?.length
                ? [`  header keys: ${server.headerKeys.join(", ")}`]
                : []),
            ]),
          ].join("\n"),
        );
        const chosen = await view.choose("Connect project MCP servers?", [
          { label: "Trust this version and connect", note: "remember this exact .mcp.json" },
          { label: "Skip project MCP", note: "continue without these servers" },
        ]);
        return chosen === "Trust this version and connect";
      },
    });
    return { runtime, binding };
  }
  async function switchSession(target: SessionTarget): Promise<void> {
    if (switching || closed) return;
    if (current.view.agent.running) {
      current.view.note("Interrupt the current turn before switching sessions.");
      return;
    }
    switching = true;
    const old = current;
    const draft = old.view.draft();
    const originalSetup = old.view.setup();
    const originalValues = JSON.stringify(originalSetup.values);
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
    let candidate: Session | undefined;
    try {
      const saved = defaults();
      let session =
        target.kind === "resume"
          ? (() => {
              const file = resolve(target.file);
              const live =
                file === resolve(old.session.sessionFile) ? old.session.log : unsaved.get(file);
              return live
                ? { log: live, sessionFile: file, resumed: true }
                : openSession({ resume: file, continue: false }, dir);
            })()
          : undefined;
      candidate = session;
      const source = target.source ?? (target.kind === "new" ? "current" : "history");
      const history =
        source === "history" && session
          ? restoreSessionSetup(session.log.events, saved.values)
          : undefined;
      let setup = history?.setup ?? (source === "defaults" ? saved : originalSetup);
      if (history?.missing.length) {
        const reviewed = await old.view.reviewSetup(setup, history.missing);
        if (!reviewed) return;
        setup = reviewed;
      }
      while (!closed) {
        const values = withCurrentDisplay(setup.values, originalSetup.values);
        try {
          const args = argsFor(values);
          if (!session) session = beginSession(args, boot.choose(args.model), process.cwd(), dir);
          candidate = session;
          old.view.note("Preparing session… Your current session remains available.");
          prepared = await prepare(session, args, setup);
          // 所有可能失败的文件读取都发生在切换之前,不改目标的模型上下文。
          const prompt =
            session.resumed && source !== "history" ? systemPromptFor(args) : undefined;
          const missingTools = setup.tools.filter(
            (name) =>
              !args.disabledTools?.includes(name) &&
              !prepared?.runtime.tools.some((tool) => tool.name === name),
          );
          const failed = prepared.runtime.mcp
            .statuses()
            .filter((status) => status.phase !== "ready");
          if (missingTools.length || failed.length) {
            let picked: string | undefined;
            do {
              picked = await old.view.choose("Some capabilities are unavailable", [
                { label: "Review details", note: "show unavailable tools and connections" },
                { label: "Retry", note: "prepare this setup again" },
                { label: "Adjust setup", note: "change model, extensions, or tool switches" },
                {
                  label: "Continue without unavailable tools",
                  note: "explicitly omit these optional capabilities",
                },
                { label: "Cancel", note: "keep the current session" },
              ]);
              if (picked === "Review details") {
                await old.view.showText(
                  "Unavailable capabilities",
                  [...missingTools, ...failed.map((s) => `${s.name}: ${s.error ?? s.phase}`)].join(
                    "\n",
                  ),
                );
              }
            } while (picked === "Review details" && !closed);
            if (picked !== "Continue without unavailable tools") {
              await prepared.runtime.dispose();
              prepared = undefined;
              if (!picked || picked === "Cancel") return;
              if (picked === "Adjust setup") {
                const review = await old.view.reviewSetup(setup, []);
                if (!review) return;
                setup = review;
              }
              continue;
            }
            args.disabledTools = [...new Set([...(args.disabledTools ?? []), ...missingTools])];
          }
          if (
            closed ||
            old.view.agent.running ||
            old.view.draft() !== draft ||
            JSON.stringify(old.view.setup().values) !== originalValues
          ) {
            old.view.note(
              "The current session changed during preparation. Keep working here and retry the switch when ready.",
            );
            return;
          }
          const showView = prepareView(session, args, prepared.runtime);
          old.view.flushInputs();
          for (const log of [
            old.session.log,
            ...old.view.children().map((child) => child.log),
            session.log,
          ]) {
            log.recording?.flush();
            retainUnsaved(log);
          }
          old.view.stop();
          prepared.runtime.activate();
          try {
            const view = showView();
            if (prompt) {
              const target = session.log.events.findIndex((e) => e.type === "session/start");
              if (target >= 0)
                session.log.append({
                  type: "context/edit",
                  at: now(),
                  target,
                  field: "system",
                  value: prompt.text,
                  sections: prompt.sections,
                  note: `Session setup: regenerate prompt from ${source}`,
                });
              if (prompt.preamble.length)
                session.log.append({
                  type: "user/message",
                  at: now(),
                  text: prompt.preamble.map((p) => p.text).join("\n\n"),
                });
            }
            prepared.binding.view = view;
            current = { session, args, view, runtime: prepared.runtime, binding: prepared.binding };
          } catch (error) {
            old.runtime?.activate();
            old.view = prepareView(old.session, old.args, old.runtime)();
            if (old.binding) old.binding.view = old.view;
            old.view.setDraft(draft);
            throw error;
          }
          prepared = undefined;
          await old.runtime
            ?.dispose()
            .catch((error) =>
              current.view.note(`Previous session cleanup failed: ${errorMessage(error)}`),
            );
          for (const log of [old.session.log, ...old.view.children().map((child) => child.log)]) {
            releaseSessionLog(log);
          }
          return;
        } catch (error) {
          await prepared?.runtime.dispose();
          prepared = undefined;
          let picked: string | undefined;
          do {
            picked = await old.view.choose("Session preparation failed", [
              { label: "View error", note: errorMessage(error) },
              { label: "Retry", note: "try the selected setup again" },
              { label: "Adjust setup", note: "repair or replace unavailable components" },
              ...(session
                ? [{ label: "View history", note: "read the target without running it" }]
                : []),
              { label: "Cancel", note: "keep the current session and draft" },
            ]);
            if (!picked || picked === "Cancel") return;
            if (picked === "View error")
              await old.view.showText("Preparation error", errorMessage(error));
            if (picked === "View history" && session)
              await old.view.showText(
                "Session history · read only",
                deriveMessages(session.log.events)
                  .map((m) => `${m.role}\n${m.content}`)
                  .join("\n\n"),
              );
          } while ((picked === "View history" || picked === "View error") && !closed);
          if (picked === "Adjust setup") {
            const reviewed = await old.view.reviewSetup(setup, []);
            if (!reviewed) return;
            setup = reviewed;
          }
        }
      }
    } finally {
      await prepared?.runtime.dispose();
      if (candidate) releaseSessionLog(candidate.log);
      switching = false;
    }
  }
  function close(reason?: string): Promise<void> {
    if (reason) {
      failure ??= reason;
      if (exitState) {
        exitState.failure = failure;
        current.view.setExitState(exitState);
      }
    }
    if (closing) return closing;
    if (closed) return Promise.resolve();
    closed = true;
    const { view, session, runtime } = current;
    const logs = () => [
      ...new Set([session.log, ...view.children().map((child) => child.log), ...unsaved.values()]),
    ];
    let forced = false;
    let finishForce!: () => void;
    const forceDone = new Promise<void>((resolve) => {
      finishForce = resolve;
    });
    const state: ExitState = {
      phase: "stopping",
      ...(failure && { failure }),
      force: () => {
        if (forced) return;
        try {
          view.flushInputs();
          session.log.append({
            type: "session/exit",
            at: now(),
            phase: state.phase,
            ...((failure || state.error) && {
              error: [failure, state.error].filter(Boolean).join("\n\n"),
            }),
          });
          recordUnresolvedCalls(session.log, "exit");
          for (const log of logs()) log.recording?.flush();
          view.stop();
          for (const log of logs()) {
            if (log.recording?.error)
              console.error(
                `Unsaved session data may be lost: ${log.path}: ${log.recording.error}`,
              );
          }
        } catch (error) {
          state.error = errorMessage(error);
          view.setExitState(state);
          return;
        }
        forced = true;
        finishForce();
        // 强制退出由宿主终止进程,不等待可能失去响应的工具或扩展清理。
        exit();
      },
    };
    exitState = state;
    // 致命异常当场锁定输入,不等保存或异步收尾后才阻止新的提交。
    if (failure) view.setExitState(state);
    const persist = async (action: () => void, wait = false) => {
      while (!forced) {
        try {
          action();
          delete state.error;
          delete state.retry;
          return;
        } catch (error) {
          if (!failure && !wait) throw error;
          state.error = error instanceof Error ? error.message : String(error);
          const retry = new Promise<void>((resolve) => {
            state.retry = () => {
              delete state.retry;
              resolve();
            };
          });
          view.setExitState(state);
          await Promise.race([retry, forceDone]);
        }
      }
    };
    const graceful = Promise.resolve().then(async () => {
      await persist(() => {
        // interrupt 即使写入失败也投递取消;此后才能等待磁盘修复。
        view.agent.interrupt();
        view.flushInputs();
      });
      if (forced) return;
      view.setExitState(state);
      await view.agent.waitForIdle().catch(() => {});
      if (forced) return;
      await persist(() => view.flushInputs());
      if (forced) return;
      state.phase = "cleanup";
      delete state.error;
      view.setExitState(state);
      // 扩展清理卡住时,连接清理仍可独立完成;界面保持可操作。
      const results = await Promise.allSettled([runtime?.dispose(), connections.close()]);
      if (forced) return;
      await persist(() => {
        for (const log of logs()) {
          log.recording?.flush();
          if (log.recording?.error)
            throw new Error(
              `Unsaved session records: ${log.path}: ${log.recording.error}. Retry saving or force exit.`,
            );
        }
      }, true);
      if (forced) return;
      const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      try {
        if (errors.length) {
          const detail = (error: unknown): string =>
            error instanceof AggregateError
              ? `${error.message}\n${error.errors.map(detail).join("\n")}`
              : error instanceof Error
                ? error.message
                : String(error);
          throw new AggregateError(errors, errors.map(detail).join("\n"));
        }
        view.stop();
        for (const log of logs()) log.recording?.dispose();
      } catch (error) {
        state.error = errorMessage(error);
        view.setExitState(state);
        await forceDone;
      }
    });
    closing = Promise.race([graceful, forceDone]).catch((error) => {
      // 致命异常的收尾再失败交给宿主兜底,不能恢复可提交的主界面。
      if (failure) throw error;
      closed = false;
      closing = undefined;
      exitState = undefined;
      view.setExitState();
      throw error;
    });
    return closing;
  }
  const session =
    options.args.resume || options.args.continue
      ? openSession(options.args, dir)
      : beginSession(options.args, first, process.cwd(), dir);
  if (session.resumed) {
    current = { session, args: options.args, view: prepareView(session, options.args)() };
    void switchSession({ kind: "resume", file: session.sessionFile }).catch((error) =>
      current.view.note(errorMessage(error)),
    );
  } else {
    const failStartup = async (error: unknown, runtime?: Runtime): Promise<never> => {
      const cleanupErrors: unknown[] = [];
      try {
        trustView?.stop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (runtime) {
        try {
          await runtime.dispose();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await connections.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      session.log.recording?.dispose();
      if (cleanupErrors.length)
        throw new AggregateError([error, ...cleanupErrors], "Session startup and cleanup failed");
      throw error;
    };
    let ready: Awaited<ReturnType<typeof prepare>>;
    try {
      ready = await prepare(session, options.args, undefined, true);
    } catch (error) {
      return failStartup(error);
    }
    try {
      trustView?.stop();
      if (closed) throw new Error("Session closed during MCP review");
      ready.runtime.activate();
      const view = prepareView(session, options.args, ready.runtime)();
      ready.binding.view = view;
      current = {
        session,
        args: options.args,
        view,
        runtime: ready.runtime,
        binding: ready.binding,
      };
    } catch (error) {
      return failStartup(error, ready.runtime);
    }
  }
  return { app: () => current.view, switchSession, close, file: () => current.session.sessionFile };
}
