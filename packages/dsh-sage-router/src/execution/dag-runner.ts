import type { SageRequirement } from "../core/types.js";
import {
  type HarnessAgentRef,
  type SageContentBlock,
  type SageObjectJsonSchema,
  type SageRequirementResult,
  type SageSubagentGateway,
  type SageSubagentResult,
  type SageSubagentRun,
  type SageToolRestriction,
} from "../harness/subagent-gateway.js";

export interface SageDagAssignment {
  requirement: SageRequirement;
  agentId: string;
  provider: string;
  subagentProvider?: string;
  model?: string;
  persona?: string;
  toolFilter?: SageToolRestriction;
  prompt: readonly SageContentBlock[];
  maxDepth?: number;
}

export type SageDagRequirementStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "blocked";

export interface SageDagRequirementResult extends SageRequirementResult {
  agentId: string;
  status: SageDagRequirementStatus;
  diagnostic?: string;
}

export interface SageDagExecutionResult {
  status: "completed" | "failed" | "aborted";
  requirementResults: readonly SageDagRequirementResult[];
  completedRequirements: readonly string[];
  failedAgents: readonly string[];
}

export interface SageDagLifecycleEvent {
  requirement: string;
  agentId: string;
  status: "started" | "completed" | "failed" | "aborted";
  score?: number;
  errorCode?: string;
}

export interface SageDagExecutionHooks {
  onRequirementEvent?(event: SageDagLifecycleEvent): void;
}

interface ActiveRun {
  assignment: SageDagAssignment;
  holder: { run?: SageSubagentRun };
  promise: Promise<SageDagRequirementResult>;
}

const outputSchema: SageObjectJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    requirementResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          requirement: { type: "string" },
          score: { type: "number" },
          summary: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } },
        },
        required: ["requirement", "score"],
      },
    },
  },
  required: ["requirementResults"],
};

export class DagRunner {
  public constructor(private readonly gateway: SageSubagentGateway) {}

  public async execute(
    assignments: readonly SageDagAssignment[],
    parent: HarnessAgentRef,
    signal: AbortSignal,
    hooks: SageDagExecutionHooks = {},
  ): Promise<SageDagExecutionResult> {
    const pending = validateAssignments(assignments);
    const finished = new Map<string, SageDagRequirementResult>();
    const active = new Map<string, ActiveRun>();

    while (pending.size > 0 || active.size > 0) {
      if (signal.aborted) {
        await this.cancelActive(active, signal);
        return summarize(assignments, finished, "aborted");
      }

      let progressed = false;
      for (const [name, assignment] of [...pending]) {
        const dependencyState = dependenciesOf(assignment, finished);
        if (dependencyState === "blocked") {
          pending.delete(name);
          const result = blockedResult(assignment, "dependency did not complete");
          finished.set(name, result);
          notify(hooks, {
            requirement: result.requirement,
            agentId: result.agentId,
            status: "failed",
            score: result.score,
            errorCode: "SAGE_DAG_DEPENDENCY_FAILED",
          });
          progressed = true;
          continue;
        }
        if (dependencyState !== "ready") continue;
        if ([...active.values()].some((run) => run.assignment.agentId === assignment.agentId)) {
          continue;
        }
        pending.delete(name);
        active.set(name, this.start(assignment, parent, signal, hooks));
        progressed = true;
      }

      if (active.size === 0) {
        if (pending.size === 0) break;
        if (!progressed) {
          for (const [name, assignment] of pending) {
            pending.delete(name);
            finished.set(name, blockedResult(assignment, "DAG has an unsatisfied dependency"));
          }
        }
        continue;
      }

      const winner = await this.raceActive(active, signal);
      if (winner === undefined) {
        await this.cancelActive(active, signal);
        return summarize(assignments, finished, "aborted");
      }
      active.delete(winner.name);
      finished.set(winner.name, winner.result);
      notify(hooks, lifecycleFromResult(winner.result));
    }

    const status = [...finished.values()].some((result) => result.status !== "completed")
      ? "failed"
      : "completed";
    return summarize(assignments, finished, status);
  }

  private start(
    assignment: SageDagAssignment,
    parent: HarnessAgentRef,
    signal: AbortSignal,
    hooks: SageDagExecutionHooks,
  ): ActiveRun {
    const holder: { run?: SageSubagentRun } = {};
    notify(hooks, {
      requirement: assignment.requirement.name,
      agentId: assignment.agentId,
      status: "started",
    });
    const promise = this.runAssignment(assignment, parent, signal, holder);
    return { assignment, holder, promise };
  }

  private async runAssignment(
    assignment: SageDagAssignment,
    parent: HarnessAgentRef,
    signal: AbortSignal,
    holder: { run?: SageSubagentRun },
  ): Promise<SageDagRequirementResult> {
    let run: SageSubagentRun | undefined;
    try {
      run = await this.gateway.start({
        requirement: assignment.requirement.name,
        agentId: assignment.agentId,
        provider: assignment.provider,
        subagentProvider: assignment.subagentProvider,
        model: assignment.model,
        parent,
        prompt: assignment.prompt,
        outputSchema,
        maxDepth: assignment.maxDepth,
        toolFilter: assignment.toolFilter,
        persona: assignment.persona,
        signal,
      });
      holder.run = run;
      const result = await run.result;
      return mapResult(assignment, result);
    } catch (error) {
      return {
        requirement: assignment.requirement.name,
        score: 0,
        agentId: assignment.agentId,
        status: signal.aborted ? "aborted" : "failed",
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (run !== undefined) await run.dispose().catch(() => undefined);
    }
  }

  private async raceActive(
    active: ReadonlyMap<string, ActiveRun>,
    signal: AbortSignal,
  ): Promise<{ name: string; result: SageDagRequirementResult } | undefined> {
    const settled = [...active].map(async ([name, run]) => ({
      name,
      result: await run.promise,
    }));
    if (signal.aborted) return undefined;
    let removeAbort: (() => void) | undefined;
    const aborted = new Promise<undefined>((resolve) => {
      const onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([Promise.race(settled), aborted]);
    } finally {
      removeAbort?.();
    }
  }

  private async cancelActive(
    active: ReadonlyMap<string, ActiveRun>,
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.allSettled(
      [...active.values()].flatMap(({ holder }) => {
        const run = holder.run;
        if (run === undefined) return [];
        return [this.gateway.interrupt(run.id, signal)];
      }),
    );
    await Promise.allSettled([...active.values()].map(({ promise }) => promise));
  }
}

function validateAssignments(
  assignments: readonly SageDagAssignment[],
): Map<string, SageDagAssignment> {
  const pending = new Map<string, SageDagAssignment>();
  for (const assignment of assignments) {
    if (pending.has(assignment.requirement.name)) {
      throw new Error(`duplicate DAG requirement: ${assignment.requirement.name}`);
    }
    pending.set(assignment.requirement.name, assignment);
  }
  for (const assignment of assignments) {
    for (const dependency of assignment.requirement.dependsOn ?? []) {
      if (!pending.has(dependency)) {
        throw new Error(
          `DAG requirement ${assignment.requirement.name} depends on unknown requirement ${dependency}`,
        );
      }
    }
  }
  return pending;
}

function dependenciesOf(
  assignment: SageDagAssignment,
  finished: ReadonlyMap<string, SageDagRequirementResult>,
): "ready" | "waiting" | "blocked" {
  let waiting = false;
  for (const dependency of assignment.requirement.dependsOn ?? []) {
    const result = finished.get(dependency);
    if (result === undefined) {
      waiting = true;
    } else if (result.status !== "completed") {
      return "blocked";
    }
  }
  return waiting ? "waiting" : "ready";
}

function mapResult(
  assignment: SageDagAssignment,
  result: SageSubagentResult,
): SageDagRequirementResult {
  const item = result.requirementResults.find(
    (candidate) => candidate.requirement === assignment.requirement.name,
  ) ?? result.requirementResults[0];
  return {
    requirement: assignment.requirement.name,
    score: item?.score ?? 0,
    agentId: assignment.agentId,
    status: result.status,
    ...(item?.summary === undefined ? {} : { summary: item.summary }),
    ...(item?.artifacts === undefined ? {} : { artifacts: item.artifacts }),
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
  };
}

function blockedResult(
  assignment: SageDagAssignment,
  diagnostic: string,
): SageDagRequirementResult {
  return {
    requirement: assignment.requirement.name,
    score: 0,
    agentId: assignment.agentId,
    status: "blocked",
    diagnostic,
  };
}

function lifecycleFromResult(
  result: SageDagRequirementResult,
): SageDagLifecycleEvent {
  return {
    requirement: result.requirement,
    agentId: result.agentId,
    status: result.status === "blocked" ? "failed" : result.status,
    score: result.score,
    ...(result.status === "blocked"
      ? { errorCode: "SAGE_DAG_DEPENDENCY_FAILED" }
      : {}),
  };
}

function notify(
  hooks: SageDagExecutionHooks,
  event: SageDagLifecycleEvent,
): void {
  hooks.onRequirementEvent?.(event);
}

function summarize(
  assignments: readonly SageDagAssignment[],
  finished: ReadonlyMap<string, SageDagRequirementResult>,
  status: SageDagExecutionResult["status"],
): SageDagExecutionResult {
  const requirementResults = assignments
    .map((assignment) => finished.get(assignment.requirement.name))
    .filter((result): result is SageDagRequirementResult => result !== undefined);
  return {
    status,
    requirementResults,
    completedRequirements: requirementResults
      .filter((result) => result.status === "completed")
      .map((result) => result.requirement),
    failedAgents: [...new Set(
      requirementResults
        .filter((result) => result.status === "failed" || result.status === "aborted")
        .map((result) => result.agentId),
    )],
  };
}
