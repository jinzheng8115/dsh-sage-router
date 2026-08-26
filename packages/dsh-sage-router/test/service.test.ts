import { deepStrictEqual, equal, match, throws } from "node:assert/strict";
import test from "node:test";

import { parseSagePluginConfig } from "../src/config.js";
import {
  SageRoutingService,
  type SageRouteInput,
} from "../src/service.js";

const pluginConfig = parseSagePluginConfig({
  agents: [
    {
      agentId: "self",
      provider: "local",
      skills: { general: 0.9 },
      cost: 1,
      latencyMs: 100,
      permissions: ["task.execute"],
    },
    {
      agentId: "specialist",
      provider: "remote",
      skills: { specialist: 0.95 },
      cost: 2,
      latencyMs: 150,
      permissions: ["task.execute"],
    },
  ],
  incumbentId: "self",
  defaultBudget: 10,
  defaultDeadlineMs: 10_000,
});

const routeInput: SageRouteInput = {
  task: {
    taskId: "service-route",
    requirements: [{ name: "general" }],
  },
};

test("routes a task, applies plugin defaults, and stores a session-local route", () => {
  const service = new SageRoutingService(pluginConfig);
  const result = service.route(routeInput);

  match(result.routeId, /^[0-9a-f-]{36}$/);
  equal(result.decision.mode, "self");
  equal(result.decision.cost <= pluginConfig.defaultBudget, true);
  deepStrictEqual(service.getRoute(result.routeId), result);
  equal(service.getRoute("missing"), undefined);
});

test("uses the configured default budget as a route constraint", () => {
  const service = new SageRoutingService({ ...pluginConfig, defaultBudget: 1 });

  throws(() => service.route(routeInput), /SAGE_ROUTE_NO_ELIGIBLE_AGENT/);
});

test("route IDs are unique and do not contain task input", () => {
  const service = new SageRoutingService(pluginConfig);
  const first = service.route(routeInput);
  const second = service.route({
    task: { ...routeInput.task, taskId: "different-task" },
  });

  equal(first.routeId === second.routeId, false);
  equal(first.routeId.includes("service-route"), false);
  equal(second.routeId.includes("different-task"), false);
});

test("records outcome against a known route and rejects unknown route IDs", () => {
  const service = new SageRoutingService(pluginConfig);
  const result = service.route(routeInput);

  service.recordOutcome(result.routeId, { success: true });
  throws(
    () => service.recordOutcome("missing", { success: true }),
    /SAGE_ROUTE_NOT_FOUND/,
  );
});

test("returns a stable no-eligible-agent route error", () => {
  const service = new SageRoutingService(pluginConfig);
  const invalid: SageRouteInput = {
    task: {
      taskId: "forbidden-route",
      requirements: [{ name: "general" }],
      requiredPermissions: ["admin.execute"],
    },
  };

  throws(() => service.route(invalid), /SAGE_ROUTE_NO_ELIGIBLE_AGENT/);
});
