import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import test from "node:test";

import { normalizeSageEvent, type SageStoredEvent } from "../src/persistence/events.js";
import { parseSagePluginConfig } from "../src/config.js";
import type { SageDecision } from "../src/core/types.js";
import {
  SageRoutingService,
  type SageService,
} from "../src/service.js";
import type {
  HarnessAgentRef,
  SageSubagentGateway,
  SageSubagentRun,
} from "../src/harness/subagent-gateway.js";

test("permission, budget, and deadline constraints fail closed at the service seam", () => {
  const service = new SageRoutingService(parseSagePluginConfig({
    agents: [
      {
        agentId: "self",
        provider: "local",
        skills: { general: 1 },
        cost: 0.5,
        latencyMs: 100,
        permissions: ["task.execute"],
      },
    ],
    incumbentId: "self",
    defaultBudget: 0.4,
    defaultDeadlineMs: 50,
  }));

  throws(
    () => service.route({
      task: {
        taskId: "security-permission",
        requirements: [{ name: "general" }],
        requiredPermissions: ["network.read"],
      },
    }),
    /SAGE_ROUTE_NO_ELIGIBLE_AGENT/,
  );
  throws(
    () => service.route({
      task: {
        taskId: "security-budget",
        requirements: [{ name: "general" }],
        budget: 0.1,
      },
    }),
    /SAGE_ROUTE_NO_ELIGIBLE_AGENT|SAGE_ROUTE_NO_FEASIBLE_ROUTE/,
  );
  throws(
    () => service.route({
      task: {
        taskId: "security-deadline",
        requirements: [{ name: "general" }],
        deadlineMs: 10,
      },
    }),
    /SAGE_ROUTE_NO_ELIGIBLE_AGENT|SAGE_ROUTE_NO_FEASIBLE_ROUTE/,
  );
});

test("restored execution rejects an assignment outside the selected route", async () => {
  const started: string[] = [];
  const gateway: SageSubagentGateway = {
    async start(input) {
      started.push(input.agentId);
      return successfulRun(input.requirement);
    },
    async interrupt() {},
  };
  const service = new SageRoutingService(
    parseSagePluginConfig({
      agents: [
        {
          agentId: "self",
          provider: "local",
          skills: { general: 1 },
          cost: 0.1,
          latencyMs: 10,
          permissions: ["task.execute"],
        },
        {
          agentId: "researcher",
          provider: "remote",
          skills: { general: 1 },
          cost: 0.1,
          latencyMs: 10,
          permissions: [],
        },
      ],
      incumbentId: "self",
      autoOrchestrate: true,
      maxCollaborators: 1,
    }),
    gateway,
  );
  const decision: SageDecision = {
    mode: "handoff",
    agents: ["self"],
    utility: 1,
    successProbability: 1,
    coverage: 1,
    cost: 0.1,
    latencyMs: 10,
    risk: 0,
    explanation: "restored route",
    assignments: { general: "researcher" },
    topology: [],
    switchRecommended: true,
    diagnostics: {},
    modelFeatures: {},
  };
  const event: SageStoredEvent = {
    type: "sage/route",
    data: {
      routeId: "restored-route",
      taskId: "restored-task",
      decision,
    },
  };
  service.restoreSessionEvents([event]);

  await rejects(
    service.orchestrate(
      "restored-route",
      { sessionId: "root", provider: "local", agent: {} } satisfies HarnessAgentRef,
      new AbortController().signal,
    ),
    /SAGE_ORCHESTRATION_POLICY_VIOLATION/,
  );
  deepStrictEqual(started, []);
});

test("route results are detached from the service execution record", () => {
  const service = new SageRoutingService(parseSagePluginConfig({
    agents: [
      {
        agentId: "self",
        provider: "local",
        skills: { general: 1 },
        cost: 0.1,
        latencyMs: 10,
      },
    ],
    incumbentId: "self",
  }));
  const route = service.route({
    task: { taskId: "detached-route", requirements: [{ name: "general" }] },
  });
  (route.decision.assignments as Record<string, string>).general = "attacker";
  equal(service.getRoute(route.routeId)?.decision.assignments.general, "self");
});

test("session event normalization strips prompt and credential fields", () => {
  const decision = safeDecision();
  const normalized = normalizeSageEvent("sage/route", {
    routeId: "safe-route",
    taskId: "safe-task",
    prompt: "do not persist this prompt",
    credential: "api-key-secret",
    decision: {
      ...decision,
      prompt: "do not persist this nested prompt",
      credential: "nested-secret",
    },
  });
  const serialized = JSON.stringify(normalized);

  ok(!serialized.includes("do not persist"));
  ok(!serialized.includes("api-key-secret"));
  ok(!serialized.includes("nested-secret"));
  match(serialized, /safe-route/);
});

function safeDecision(): SageDecision {
  return {
    mode: "self",
    agents: ["self"],
    utility: 1,
    successProbability: 1,
    coverage: 1,
    cost: 0.1,
    latencyMs: 10,
    risk: 0,
    explanation: "safe route",
    assignments: { general: "self" },
    topology: [],
    switchRecommended: false,
    diagnostics: {},
    modelFeatures: {},
  };
}

function successfulRun(requirement: string): SageSubagentRun {
  return {
    id: `run-${requirement}`,
    result: Promise.resolve({
      status: "completed",
      requirementResults: [{ requirement, score: 1 }],
    }),
    dispose: async () => {},
  };
}
