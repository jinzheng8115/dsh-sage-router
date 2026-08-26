import { randomUUID } from "node:crypto";

import { SageRouter } from "./core/router.js";
import type {
  SageBid,
  SageDecision,
  SageExecutionState,
  SageOutcome,
  SageTask,
} from "./core/types.js";
import { createAgentCatalog, type AgentCatalog } from "./harness/agent-catalog.js";
import type { HarnessAgentRef, SageSubagentGateway } from "./harness/subagent-gateway.js";
import {
  DefaultSageOrchestrator,
  type SageExecutionHooks,
  type SageExecutionResult,
  type SageOrchestrator,
} from "./execution/orchestrator.js";
import type { SagePluginConfig } from "./config.js";
import {
  appendSageEvent,
  createSageSessionEventAppender,
  type SageEventAppender,
  type SageExecutionEvent,
  type SageLearningState,
  type SageSessionLike,
} from "./persistence/events.js";
import { foldSageEvents } from "./persistence/fold.js";
import type { SageLearningStore } from "./persistence/learning-store.js";

export interface SageRouteInput {
  task: SageTask;
  bids?: readonly SageBid[];
  state?: SageExecutionState;
  eventSink?: SageEventAppender;
}

export interface SageRouteResult {
  routeId: string;
  decision: SageDecision;
}

export interface SagePlannedResult {
  routeId: string;
  status: "planned";
  decision: SageDecision;
}

export type SageOrchestrationResult = SageExecutionResult | SagePlannedResult;

export interface SageService {
  route(input: SageRouteInput): SageRouteResult;
  recordOutcome(routeId: string, outcome: SageOutcome | number | boolean): void;
  recordOutcomeAsync(
    routeId: string,
    outcome: SageOutcome | number | boolean,
  ): Promise<void>;
  getRoute(routeId: string): SageRouteResult | undefined;
  learningState(): SageLearningState;
  flushPersistence(): Promise<void>;
  /**
   * Session-log sink for `sage/*` events, or undefined while
   * `sessionEventLog` is disabled (the default — see config.ts for why).
   */
  sessionAppenderFor(session: SageSessionLike): SageEventAppender | undefined;
  orchestrate(
    routeId: string,
    parent: HarnessAgentRef | undefined,
    signal: AbortSignal,
  ): Promise<SageOrchestrationResult>;
}

export type SageRouteErrorCode =
  | "SAGE_ROUTE_INVALID_INPUT"
  | "SAGE_ROUTE_NO_ELIGIBLE_AGENT"
  | "SAGE_ROUTE_NO_FEASIBLE_ROUTE"
  | "SAGE_ROUTE_NOT_FOUND"
  | "SAGE_ROUTE_OUTCOME_INVALID"
  | "SAGE_ORCHESTRATION_PARENT_REQUIRED"
  | "SAGE_ORCHESTRATION_UNAVAILABLE"
  | "SAGE_ORCHESTRATION_POLICY_VIOLATION"
  | "SAGE_PERSISTENCE_UNCERTAIN"
  | "SAGE_ROUTE_INTERNAL";

export class SageRouteError extends Error {
  public constructor(
    public readonly code: SageRouteErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options);
    this.name = "SageRouteError";
  }
}

interface RouteRecord extends SageRouteResult {
  readonly taskId: string;
  readonly task: SageTask;
  readonly eventSink?: SageEventAppender;
}

export interface SageRoutingServiceOptions {
  eventSink?: SageEventAppender;
  learningState?: SageLearningState;
  learningStore?: SageLearningStore;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function routeError(error: unknown): SageRouteError {
  if (error instanceof SageRouteError) {
    return error;
  }
  const message = messageOf(error);
  if (message.startsWith("no eligible agent")) {
    return new SageRouteError("SAGE_ROUTE_NO_ELIGIBLE_AGENT", message, {
      cause: error,
    });
  }
  if (message.startsWith("no feasible route")) {
    return new SageRouteError("SAGE_ROUTE_NO_FEASIBLE_ROUTE", message, {
      cause: error,
    });
  }
  if (
    /task|requirement|permission|budget|deadline|state|bid|agent/i.test(message)
  ) {
    return new SageRouteError("SAGE_ROUTE_INVALID_INPUT", message, {
      cause: error,
    });
  }
  return new SageRouteError("SAGE_ROUTE_INTERNAL", message, { cause: error });
}

export class SageRoutingService implements SageService {
  public readonly catalog: AgentCatalog;
  private readonly router: SageRouter;
  private readonly config: SagePluginConfig;
  private readonly routes = new Map<string, RouteRecord>();
  private readonly orchestrator: SageOrchestrator | undefined;
  private readonly defaultEventSink: SageEventAppender | undefined;
  private readonly learningStore: SageLearningStore | undefined;
  private learningRevision = 0;
  private pendingPersistence: Promise<void> = Promise.resolve();
  private persistenceError: unknown;

  public constructor(
    config: SagePluginConfig,
    gateway?: SageSubagentGateway,
    options: SageRoutingServiceOptions = {},
  ) {
    this.config = config;
    this.catalog = createAgentCatalog(config);
    this.router = new SageRouter(this.catalog.coreAgents(), config.incumbentId, {
      weights: config.weights,
      maxCollaborators: config.maxCollaborators,
      beamWidth: config.beamWidth,
      exploration: config.exploration,
    });
    this.defaultEventSink = options.eventSink;
    this.learningStore = options.learningStore;
    if (options.learningState !== undefined) {
      this.router.restoreLearningState(options.learningState);
      this.learningRevision = options.learningState.revision;
    }
    this.orchestrator = gateway === undefined
      ? undefined
      : new DefaultSageOrchestrator({
        catalog: this.catalog,
        gateway,
        incumbentId: config.incumbentId,
        maxDelegationDepth: config.maxDelegationDepth,
        replan: (task, state) => this.router.route(task, undefined, state),
      });
  }

  public route(input: SageRouteInput): SageRouteResult {
    try {
      const task = cloneTask({
        ...input.task,
        budget: input.task.budget ?? this.config.defaultBudget,
        deadlineMs: input.task.deadlineMs ?? this.config.defaultDeadlineMs,
      });
      const decision = this.router.route(task, input.bids, input.state);
      const result: RouteRecord = {
        routeId: randomUUID(),
        taskId: task.taskId,
        task,
        decision,
        eventSink: input.eventSink ?? this.defaultEventSink,
      };
      if (result.eventSink !== undefined) {
        try {
          appendSageEvent(result.eventSink, "sage/route", {
            routeId: result.routeId,
            taskId: result.taskId,
            decision: result.decision,
            ...(input.state === undefined ? {} : { activeState: input.state }),
          });
        } catch (error) {
          throw new SageRouteError(
            "SAGE_PERSISTENCE_UNCERTAIN",
            messageOf(error),
            { cause: error },
          );
        }
      }
      this.queueEventFlush(result.eventSink);
      this.routes.set(result.routeId, result);
      return { routeId: result.routeId, decision: cloneDecision(result.decision) };
    } catch (error) {
      throw routeError(error);
    }
  }

  public recordOutcome(
    routeId: string,
    outcome: SageOutcome | number | boolean,
  ): void {
    const record = this.routes.get(routeId);
    if (!record) {
      throw new SageRouteError(
        "SAGE_ROUTE_NOT_FOUND",
        `route_id is not registered: ${routeId}`,
      );
    }
    try {
      this.applyOutcome(record, outcome);
    } catch (error) {
      if (error instanceof SageRouteError) throw error;
      const message = messageOf(error);
      throw new SageRouteError("SAGE_ROUTE_OUTCOME_INVALID", message, {
        cause: error,
      });
    }
  }

  public async recordOutcomeAsync(
    routeId: string,
    outcome: SageOutcome | number | boolean,
  ): Promise<void> {
    this.recordOutcome(routeId, outcome);
    await this.flushPersistence();
  }

  public getRoute(routeId: string): SageRouteResult | undefined {
    const record = this.routes.get(routeId);
    if (!record) return undefined;
    return { routeId: record.routeId, decision: cloneDecision(record.decision) };
  }

  public learningState(): SageLearningState {
    return {
      revision: this.learningRevision,
      ...this.router.snapshotLearningState(),
    };
  }

  public async flushPersistence(): Promise<void> {
    await this.pendingPersistence;
    if (this.persistenceError !== undefined) {
      throw new SageRouteError(
        "SAGE_PERSISTENCE_UNCERTAIN",
        messageOf(this.persistenceError),
        { cause: this.persistenceError },
      );
    }
  }

  public restoreSessionEvents(
    events: readonly unknown[],
    eventSink?: SageEventAppender,
  ): void {
    const folded = foldSageEvents(events);
    if (folded.learningState !== undefined && folded.revision > this.learningRevision) {
      this.router.restoreLearningState(folded.learningState);
      this.learningRevision = folded.revision;
    }
    for (const route of Object.values(folded.routes)) {
      const task: SageTask = {
        taskId: route.taskId,
        requirements: Object.keys(route.decision.assignments).map((name) => ({ name })),
      };
      this.routes.set(route.routeId, {
        routeId: route.routeId,
        taskId: route.taskId,
        task,
        decision: cloneDecision(route.decision),
        eventSink,
      });
    }
  }

  public sessionAppenderFor(
    session: SageSessionLike,
  ): SageEventAppender | undefined {
    return this.config.sessionEventLog === true
      ? createSageSessionEventAppender(session)
      : undefined;
  }

  public async orchestrate(
    routeId: string,
    parent: HarnessAgentRef | undefined,
    signal: AbortSignal,
  ): Promise<SageOrchestrationResult> {
    const record = this.routes.get(routeId);
    if (record === undefined) {
      throw new SageRouteError(
        "SAGE_ROUTE_NOT_FOUND",
        `route_id is not registered: ${routeId}`,
      );
    }
    if (!this.config.autoOrchestrate) {
      return { routeId, status: "planned", decision: record.decision };
    }
    if (parent === undefined) {
      throw new SageRouteError(
        "SAGE_ORCHESTRATION_PARENT_REQUIRED",
        "auto orchestration requires a live parent Agent",
      );
    }
    try {
      validateOrchestrationPolicy(record.task, record.decision, this.config, this.catalog);
    } catch (error) {
      throw new SageRouteError(
        "SAGE_ORCHESTRATION_POLICY_VIOLATION",
        messageOf(error),
        { cause: error },
      );
    }
    if (this.orchestrator === undefined) {
      throw new SageRouteError(
        "SAGE_ORCHESTRATION_UNAVAILABLE",
        "ctx.subagents is not available",
      );
    }
    try {
      let persistenceError: unknown;
      const hooks: SageExecutionHooks = {
        onRequirementEvent: (event: Omit<SageExecutionEvent, "routeId">) => {
          if (record.eventSink === undefined || persistenceError !== undefined) return;
          try {
            appendSageEvent(record.eventSink, "sage/execution", {
              routeId: record.routeId,
              ...event,
            });
          } catch (error) {
            persistenceError ??= error;
          }
        },
      };
      const result = await this.orchestrator.execute(
        record.task,
        record.decision,
        parent,
        signal,
        routeId,
        hooks,
      );
      if (result.status === "replanned" && result.nextDecision !== undefined) {
        record.decision = result.nextDecision;
        if (record.eventSink !== undefined && persistenceError === undefined) {
          try {
            appendSageEvent(record.eventSink, "sage/route", {
              routeId: record.routeId,
              taskId: record.taskId,
              decision: result.nextDecision,
              ...(result.replanState === undefined
                ? {}
                : { activeState: result.replanState }),
            });
          } catch (error) {
            persistenceError ??= error;
          }
        }
      }
      if (result.outcome !== undefined) {
        try {
          this.applyOutcome(record, result.outcome);
        } catch (error) {
          persistenceError ??= error;
        }
      }
      try {
        await this.flushPersistence();
      } catch (error) {
        persistenceError ??= error;
      }
      if (persistenceError !== undefined) {
        return {
          ...result,
          persistenceUncertain: true,
          diagnostic: `${result.diagnostic ?? "execution completed"}; persistence uncertain: ${messageOf(persistenceError)}`,
        };
      }
      return result;
    } catch (error) {
      if (error instanceof SageRouteError) throw error;
      throw new SageRouteError(
        "SAGE_ROUTE_INTERNAL",
        messageOf(error),
        { cause: error },
      );
    }
  }

  private applyOutcome(
    record: RouteRecord,
    outcome: SageOutcome | number | boolean,
  ): void {
    this.router.recordOutcome(record.decision, outcome);
    const state: SageLearningState = {
      revision: this.learningRevision + 1,
      ...this.router.snapshotLearningState(),
    };
    if (record.eventSink !== undefined) {
      try {
        appendSageEvent(record.eventSink, "sage/outcome", {
          routeId: record.routeId,
          outcome: normalizeOutcomeForPersistence(outcome),
        });
        appendSageEvent(record.eventSink, "sage/model-update", {
          routeId: record.routeId,
          state,
        });
      } catch (error) {
        throw new SageRouteError(
          "SAGE_PERSISTENCE_UNCERTAIN",
          messageOf(error),
          { cause: error },
        );
      }
    }
    this.learningRevision = state.revision;
    this.queueLearningState(state);
    this.queueEventFlush(record.eventSink);
  }

  private queueLearningState(state: SageLearningState): void {
    if (this.learningStore === undefined) return;
    const expectedRevision = state.revision - 1;
    this.pendingPersistence = this.pendingPersistence.then(async () => {
      try {
        await this.learningStore!.save(expectedRevision, state);
      } catch (error) {
        this.persistenceError ??= error;
      }
    });
  }

  private queueEventFlush(eventSink: SageEventAppender | undefined): void {
    if (eventSink?.flush === undefined) return;
    this.pendingPersistence = this.pendingPersistence.then(async () => {
      try {
        await eventSink.flush!();
      } catch (error) {
        this.persistenceError ??= error;
      }
    });
  }
}

function cloneTask(task: SageTask): SageTask {
  return {
    ...task,
    requirements: task.requirements.map((requirement) => ({
      ...requirement,
      ...(requirement.dependsOn === undefined
        ? {}
        : { dependsOn: [...requirement.dependsOn] }),
    })),
    ...(task.requiredPermissions === undefined
      ? {}
      : { requiredPermissions: [...task.requiredPermissions] }),
  };
}

function cloneDecision(decision: SageDecision): SageDecision {
  return {
    ...decision,
    agents: [...decision.agents],
    assignments: { ...decision.assignments },
    topology: decision.topology.map(([from, to]) => [from, to]),
    diagnostics: { ...decision.diagnostics },
    modelFeatures: { ...decision.modelFeatures },
  };
}

function validateOrchestrationPolicy(
  task: SageTask,
  decision: SageDecision,
  config: SagePluginConfig,
  catalog: AgentCatalog,
): void {
  const selected = new Set(decision.agents);
  if (decision.agents.length === 0 || selected.size !== decision.agents.length) {
    throw new Error("selected agents must be non-empty and unique");
  }
  if (
    decision.mode === "self" &&
    (selected.size !== 1 || !selected.has(config.incumbentId))
  ) {
    throw new Error("SELF must keep the configured incumbent as the only agent");
  }
  if (
    decision.mode === "collaborate" &&
    (!selected.has(config.incumbentId) || selected.size < 2)
  ) {
    throw new Error("COLLABORATE must include the incumbent and a collaborator");
  }
  if (
    decision.mode !== "self" &&
    decision.mode !== "collaborate" &&
    decision.mode !== "handoff"
  ) {
    throw new Error("execution mode is invalid");
  }
  const maximumAgents = decision.mode === "collaborate"
    ? config.maxCollaborators + 1
    : 1;
  if (selected.size > maximumAgents) {
    throw new Error(
      `selected agents exceed the collaborator limit of ${config.maxCollaborators}`,
    );
  }
  if (decision.cost > (task.budget ?? Number.POSITIVE_INFINITY)) {
    throw new Error("selected route exceeds the task budget");
  }
  if (decision.latencyMs > (task.deadlineMs ?? Number.POSITIVE_INFINITY)) {
    throw new Error("selected route exceeds the task deadline");
  }

  const requirements = new Set(task.requirements.map((requirement) => requirement.name));
  const assignments = Object.entries(decision.assignments);
  if (assignments.length !== requirements.size) {
    throw new Error("execution assignments must cover each task requirement exactly once");
  }
  const requiredPermissions = new Set(task.requiredPermissions ?? []);
  for (const [requirement, agentId] of assignments) {
    if (!requirements.has(requirement)) {
      throw new Error(`execution assignment references unknown requirement: ${requirement}`);
    }
    if (!selected.has(agentId)) {
      throw new Error(`execution assignment uses an unselected agent: ${agentId}`);
    }
    const agent = catalog.get(agentId);
    if (agent === undefined) {
      throw new Error(`execution assignment uses an unknown agent: ${agentId}`);
    }
    const permissions = new Set(agent.permissions ?? []);
    for (const permission of requiredPermissions) {
      if (!permissions.has(permission)) {
        throw new Error(`agent ${agentId} lacks required permission: ${permission}`);
      }
    }
  }
}

function normalizeOutcomeForPersistence(
  outcome: SageOutcome | number | boolean,
): SageOutcome {
  if (typeof outcome === "object" && outcome !== null) {
    return {
      success: outcome.success,
      ...(outcome.agentScores === undefined
        ? {}
        : { agentScores: { ...outcome.agentScores } }),
      ...(outcome.requirementScores === undefined
        ? {}
        : { requirementScores: { ...outcome.requirementScores } }),
      ...(outcome.actualCost === undefined
        ? {}
        : { actualCost: outcome.actualCost }),
      ...(outcome.actualLatencyMs === undefined
        ? {}
        : { actualLatencyMs: outcome.actualLatencyMs }),
    };
  }
  return { success: outcome };
}
