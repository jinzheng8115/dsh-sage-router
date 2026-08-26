import { defineTool, type JsonValue, type ToolRunContext } from "@deepseek-ai/dsh-tools";

import type { SageBid, SageDecision, SageExecutionState, SageTask } from "../core/types.js";
import type { HarnessAgentRef } from "../harness/subagent-gateway.js";
import type { SageSessionLike } from "../persistence/events.js";
import {
  SageRouteError,
  type SageOrchestrationResult,
  type SageService,
} from "../service.js";

const orchestrateTaskParameters = {
  task: {
    type: "object",
    required: true,
    additionalProperties: true,
    description: "SAGE task with taskId and a non-empty requirements array.",
  },
  bids: {
    type: "array",
    items: { type: "object", additionalProperties: true },
    description: "Optional agent bids for this task.",
  },
  state: {
    type: "object",
    additionalProperties: true,
    description: "Optional active execution state used for switching and replanning.",
  },
} as const;

const orchestrateTaskOutput = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      routeId: { type: "string", required: true },
      status: { type: "string", required: true },
    },
  },
  render(_args: unknown, value: { routeId: string; status: string }) {
    return [
      {
        type: "text" as const,
        text: `SAGE orchestration ${value.status} for route ${value.routeId}.`,
      },
    ];
  },
} as const;

function assertKnownArguments(args: Record<string, unknown>): void {
  const allowed = new Set(["task", "bids", "state"]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new SageRouteError(
      "SAGE_ROUTE_INVALID_INPUT",
      `unknown sage_orchestrate_task argument(s): ${unknown.join(", ")}`,
    );
  }
}

export function createSageOrchestrateTask(service: SageService) {
  return defineTool({
    name: "sage_orchestrate_task",
    description:
      "计算 SAGE 路由并按 autoOrchestrate 配置执行 SELF、COLLABORATE 或 HANDOFF；默认只返回计划。",
    parameters: orchestrateTaskParameters,
    output: orchestrateTaskOutput,
    async execute(args, exec: ToolRunContext) {
      assertKnownArguments(args as Record<string, unknown>);
      const route = service.route({
        task: args.task as unknown as SageTask,
        bids: args.bids as unknown as readonly SageBid[] | undefined,
        state: args.state as unknown as SageExecutionState | undefined,
        eventSink: eventSinkOf(service, exec),
      });
      const result = await service.orchestrate(
        route.routeId,
        parentOf(exec),
        exec.signal,
      );
      return serializableResult(result);
    },
  });
}

function eventSinkOf(service: SageService, exec: ToolRunContext) {
  const session = exec.agent?.session;
  return session === undefined
    ? undefined
    : service.sessionAppenderFor(session as unknown as SageSessionLike);
}

function parentOf(exec: ToolRunContext): HarnessAgentRef | undefined {
  const agent = exec.agent;
  if (agent === undefined) return undefined;
  return {
    sessionId: String(agent.id),
    provider: agent.options.provider ?? "default",
    ...(agent.options.model === undefined ? {} : { model: agent.options.model }),
    agent,
  };
}

type OrchestrationToolOutput = {
  routeId: string;
  status: string;
} & Record<string, JsonValue>;

function serializableResult(result: SageOrchestrationResult): OrchestrationToolOutput {
  const output: OrchestrationToolOutput = {
    routeId: result.routeId,
    status: result.status,
  };
  if ("decision" in result) {
    output.decision = serializeDecision(result.decision);
    return output;
  }
  output.requirementResults = result.requirementResults.map((item) => ({
    requirement: item.requirement,
    score: item.score,
    agentId: item.agentId ?? "",
    status: "status" in item && typeof item.status === "string" ? item.status : "completed",
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(item.artifacts === undefined ? {} : { artifacts: [...item.artifacts] }),
  }));
  if (result.outcome !== undefined) {
    output.outcome = {
      success: result.outcome.success,
      ...(result.outcome.agentScores === undefined ? {} : { agentScores: { ...result.outcome.agentScores } }),
      ...(result.outcome.requirementScores === undefined
        ? {}
        : { requirementScores: { ...result.outcome.requirementScores } }),
    };
  }
  if (result.nextDecision !== undefined) output.nextDecision = serializeDecision(result.nextDecision);
  if (result.continuation !== undefined) output.continuation = { ...result.continuation };
  if (result.diagnostic !== undefined) output.diagnostic = result.diagnostic;
  if (result.persistenceUncertain !== undefined) {
    output.persistenceUncertain = result.persistenceUncertain;
  }
  return output;
}

function serializeDecision(decision: SageDecision): JsonValue {
  return {
    mode: decision.mode,
    agents: [...decision.agents],
    utility: decision.utility,
    successProbability: decision.successProbability,
    coverage: decision.coverage,
    cost: decision.cost,
    latencyMs: decision.latencyMs,
    risk: decision.risk,
    explanation: decision.explanation,
    assignments: { ...decision.assignments },
    topology: decision.topology.map(([from, to]) => [from, to]),
    switchRecommended: decision.switchRecommended,
    diagnostics: { ...decision.diagnostics },
    modelFeatures: { ...decision.modelFeatures },
  };
}
