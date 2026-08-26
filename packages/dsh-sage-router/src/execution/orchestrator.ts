import { randomUUID } from "node:crypto";

import type {
  SageDecision,
  SageExecutionState,
  SageOutcome,
  SageTask,
} from "../core/types.js";
import type { SageAgentConfig } from "../config.js";
import { AgentCatalog } from "../harness/agent-catalog.js";
import {
  type HarnessAgentRef,
  type SageContentBlock,
  type SageRequirementResult,
  type SageSubagentGateway,
} from "../harness/subagent-gateway.js";
import {
  DagRunner,
  type SageDagLifecycleEvent,
  type SageDagAssignment,
  type SageDagExecutionResult,
} from "./dag-runner.js";
import type { SageExecutionEvent } from "../persistence/events.js";

export interface SageExecutionContinuation {
  mode: "self";
  agentId: string;
}

export interface SageExecutionResult {
  routeId: string;
  status: "self" | "completed" | "failed" | "aborted" | "replanned";
  outcome?: SageOutcome;
  requirementResults: readonly SageRequirementResult[];
  nextDecision?: SageDecision;
  replanState?: SageExecutionState;
  continuation?: SageExecutionContinuation;
  diagnostic?: string;
  persistenceUncertain?: boolean;
}

export interface SageExecutionHooks {
  onRequirementEvent?(event: Omit<SageExecutionEvent, "routeId">): void;
}

export interface SageOrchestrator {
  execute(
    task: SageTask,
    decision: SageDecision,
    parent: HarnessAgentRef,
    signal: AbortSignal,
    routeId?: string,
    hooks?: SageExecutionHooks,
  ): Promise<SageExecutionResult>;
}

export interface SageOrchestratorOptions {
  catalog: AgentCatalog;
  gateway: SageSubagentGateway;
  incumbentId?: string;
  maxDelegationDepth?: number;
  replan?: (task: SageTask, state: SageExecutionState) => SageDecision;
}

export class DefaultSageOrchestrator implements SageOrchestrator {
  private readonly runner: DagRunner;

  public constructor(private readonly options: SageOrchestratorOptions) {
    this.runner = new DagRunner(options.gateway);
  }

  public async execute(
    task: SageTask,
    decision: SageDecision,
    parent: HarnessAgentRef,
    signal: AbortSignal,
    routeId = randomUUID(),
    hooks: SageExecutionHooks = {},
  ): Promise<SageExecutionResult> {
    if (signal.aborted) {
      return { routeId, status: "aborted", requirementResults: [] };
    }
    if (decision.mode === "self") {
      return {
        routeId,
        status: "self",
        requirementResults: [],
        continuation: { mode: "self", agentId: parent.sessionId },
      };
    }

    const assignments = this.assignments(task, decision);
    const dag = await this.runner.execute(assignments, parent, signal, {
      onRequirementEvent: (event: SageDagLifecycleEvent) => {
        hooks.onRequirementEvent?.(event);
      },
    });
    const outcome = outcomeOf(task, dag);
    if (dag.status === "aborted") {
      return {
        routeId,
        status: "aborted",
        outcome,
        requirementResults: dag.requirementResults,
      };
    }
    if (dag.status === "failed") {
      return this.replanOrFail(routeId, task, decision, dag, outcome, parent);
    }
    return {
      routeId,
      status: "completed",
      outcome,
      requirementResults: dag.requirementResults,
    };
  }

  private assignments(
    task: SageTask,
    decision: SageDecision,
  ): readonly SageDagAssignment[] {
    return task.requirements.map((requirement) => {
      const agentId = decision.assignments[requirement.name];
      if (agentId === undefined) {
        throw new Error(`SAGE_EXECUTION_UNASSIGNED_REQUIREMENT: ${requirement.name}`);
      }
      const agent = this.options.catalog.get(agentId);
      if (agent === undefined) {
        throw new Error(`SAGE_EXECUTION_UNKNOWN_AGENT: ${agentId}`);
      }
      return {
        requirement,
        agentId,
        provider: agent.provider,
        subagentProvider: subagentProviderOf(agent),
        model: agent.model,
        persona: agent.persona,
        toolFilter: agent.toolFilter,
        prompt: promptFor(requirement.name),
        maxDepth: this.options.maxDelegationDepth ?? 1,
      };
    });
  }

  private replanOrFail(
    routeId: string,
    task: SageTask,
    decision: SageDecision,
    dag: SageDagExecutionResult,
    outcome: SageOutcome,
    parent: HarnessAgentRef,
  ): SageExecutionResult {
    if (this.options.replan === undefined) {
      return {
        routeId,
        status: "failed",
        outcome,
        requirementResults: dag.requirementResults,
        diagnostic: "child execution failed and no replan callback is configured",
      };
    }
    const state: SageExecutionState = {
      activeAgents: [...new Set([
        this.options.incumbentId ?? parent.sessionId,
        ...decision.agents,
      ])],
      activeMode: decision.mode,
      completedRequirements: dag.completedRequirements,
      progress: task.requirements.length === 0
        ? 0
        : dag.completedRequirements.length / task.requirements.length,
      transferableContext: task.contextTransferability ?? 0,
      failedAgents: dag.failedAgents,
      failureCount: 1,
    };
    try {
      return {
        routeId,
        status: "replanned",
        outcome,
        requirementResults: dag.requirementResults,
        replanState: state,
        nextDecision: this.options.replan(task, state),
      };
    } catch (error) {
      return {
        routeId,
        status: "failed",
        outcome,
        requirementResults: dag.requirementResults,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function subagentProviderOf(agent: SageAgentConfig): string | undefined {
  return agent.subagentProvider;
}

function promptFor(requirement: string): readonly SageContentBlock[] {
  return [
    {
      type: "text",
      text: `Complete the assigned requirement: ${requirement}. Return structured requirementResults with a score from 0 to 1.`,
    },
  ];
}

function outcomeOf(task: SageTask, dag: SageDagExecutionResult): SageOutcome {
  const requirementScores: Record<string, number> = {};
  const agentScores = new Map<string, number[]>();
  for (const result of dag.requirementResults) {
    requirementScores[result.requirement] = result.score;
    const scores = agentScores.get(result.agentId) ?? [];
    scores.push(result.score);
    agentScores.set(result.agentId, scores);
  }
  const normalizedAgentScores: Record<string, number> = {};
  for (const [agentId, scores] of agentScores) {
    normalizedAgentScores[agentId] = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }
  const meetsMinimums = task.requirements.every((requirement) =>
    (requirementScores[requirement.name] ?? 0) >= (requirement.minimum ?? 0),
  );
  return {
    success: dag.status === "completed" && meetsMinimums,
    agentScores: normalizedAgentScores,
    requirementScores,
  };
}
