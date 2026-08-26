import { defineTool, type JsonValue, type ToolRunContext } from "@deepseek-ai/dsh-tools";

import type { SageBid, SageExecutionState, SageTask } from "../core/types.js";
import { SageRouteError, type SageRouteResult, type SageService } from "../service.js";
import type { SageSessionLike } from "../persistence/events.js";

const routeTaskParameters = {
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

type RouteTaskOutputValue = {
  routeId: string;
  decision: Record<string, JsonValue>;
};

const routeTaskOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      routeId: { type: "string", required: true },
      decision: { type: "object", additionalProperties: true, required: true },
    },
  },
  render(_args: unknown, value: RouteTaskOutputValue) {
    const decision = value.decision;
    const mode = typeof decision.mode === "string" ? decision.mode.toUpperCase() : "UNKNOWN";
    const agentsValue = decision.agents;
    const agents = Array.isArray(agentsValue)
      ? agentsValue.filter((agent: unknown): agent is string => typeof agent === "string")
      : [];
    const routeId = typeof value.routeId === "string" ? value.routeId : "unknown";
    return [
      {
        type: "text" as const,
        text: "SAGE route " + routeId + ": " + mode + " via [" + agents.join(", ") + "].",
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
      "unknown sage_route_task argument(s): " + unknown.join(", "),
    );
  }
}

function serializableResult(result: SageRouteResult) {
  return {
    routeId: result.routeId,
    decision: {
      mode: result.decision.mode,
      agents: [...result.decision.agents],
      utility: result.decision.utility,
      successProbability: result.decision.successProbability,
      coverage: result.decision.coverage,
      cost: result.decision.cost,
      latencyMs: result.decision.latencyMs,
      risk: result.decision.risk,
      explanation: result.decision.explanation,
      assignments: { ...result.decision.assignments },
      topology: result.decision.topology.map(([from, to]) => [from, to]),
      switchRecommended: result.decision.switchRecommended,
      diagnostics: { ...result.decision.diagnostics },
      modelFeatures: { ...result.decision.modelFeatures },
    },
  };
}

export function createSageRouteTask(service: SageService) {
  return defineTool({
    name: "sage_route_task",
    description:
      "计算一个任务的 SAGE 路由（SELF、HANDOFF 或 COLLABORATE）。只做候选过滤和决策，不启动子 Agent、不执行工具。",
    parameters: routeTaskParameters,
    output: routeTaskOutput,
    execute(args, exec: ToolRunContext) {
      assertKnownArguments(args as Record<string, unknown>);
      const result = service.route({
        task: args.task as unknown as SageTask,
        bids: args.bids as unknown as readonly SageBid[] | undefined,
        state: args.state as unknown as SageExecutionState | undefined,
        eventSink: eventSinkOf(service, exec),
      });
      return Promise.resolve(serializableResult(result));
    },
  });
}

function eventSinkOf(service: SageService, exec: ToolRunContext) {
  const session = exec.agent?.session;
  return session === undefined
    ? undefined
    : service.sessionAppenderFor(session as unknown as SageSessionLike);
}
