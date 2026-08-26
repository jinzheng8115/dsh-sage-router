import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SageRouter,
  type SageAgent,
  type SageMode,
  type SageTask,
} from "../src/index.js";

interface RouteFixture {
  name: string;
  agents: SageAgent[];
  incumbentId: string;
  task: SageTask;
  expectedMode: SageMode;
  expectedAgents: string[];
}

const routeFixtures = JSON.parse(
  readFileSync("test/fixtures/route-cases.json", "utf8"),
) as RouteFixture[];

test("keeps the incumbent for an easy task when a peer is expensive", () => {
  const agents: SageAgent[] = [
    { agentId: "current", skills: { writing: 0.94 }, cost: 0.02, latencyMs: 300 },
    { agentId: "peer", skills: { writing: 0.97 }, cost: 0.8, latencyMs: 500 },
  ];
  const task: SageTask = {
    taskId: "easy",
    requirements: [{ name: "writing", minimum: 0.6 }],
    value: 1,
    budget: 0.5,
    deadlineMs: 2000,
  };

  const decision = new SageRouter(agents, "current").route(task);

  assert.equal(decision.mode, "self");
  assert.deepEqual(decision.agents, ["current"]);
});

test("hands off to a clear specialist", () => {
  const agents: SageAgent[] = [
    { agentId: "current", skills: { security: 0.12 }, cost: 0.02, latencyMs: 300 },
    { agentId: "specialist", skills: { security: 0.99 }, cost: 0.05, latencyMs: 450 },
  ];
  const task: SageTask = {
    taskId: "audit",
    requirements: [{ name: "security", minimum: 0.8 }],
    budget: 0.2,
    deadlineMs: 2000,
    progress: 0.05,
  };

  const decision = new SageRouter(agents, "current").route(task);

  assert.equal(decision.mode, "handoff");
  assert.deepEqual(decision.agents, ["specialist"]);
});

test("collaborates when agents have complementary skills", () => {
  const agents: SageAgent[] = [
    { agentId: "current", skills: { planning: 0.96, coding: 0.12 }, cost: 0.02, latencyMs: 300 },
    { agentId: "coder", skills: { planning: 0.1, coding: 0.98 }, cost: 0.03, latencyMs: 400 },
  ];
  const task: SageTask = {
    taskId: "feature",
    requirements: [
      { name: "planning", weight: 0.5, minimum: 0.75 },
      { name: "coding", weight: 0.5, minimum: 0.75 },
    ],
    budget: 0.2,
    deadlineMs: 2000,
    progress: 0.55,
    coordinationOverhead: 0.02,
  };

  const decision = new SageRouter(agents, "current").route(task);

  assert.equal(decision.mode, "collaborate");
  assert.deepEqual([...decision.agents].sort(), ["coder", "current"]);
});

test("uses permissions as a hard eligibility filter", () => {
  const agents: SageAgent[] = [
    {
      agentId: "current",
      skills: { finance: 0.75 },
      cost: 0.02,
      latencyMs: 300,
      permissions: ["ledger:write"],
    },
    { agentId: "untrusted", skills: { finance: 1 }, cost: 0, latencyMs: 100 },
  ];
  const task: SageTask = {
    taskId: "settle",
    requirements: [{ name: "finance" }],
    requiredPermissions: ["ledger:write"],
    budget: 0.2,
    deadlineMs: 2000,
  };

  const decision = new SageRouter(agents, "current").route(task);

  assert.ok(!decision.agents.includes("untrusted"));
});

test("rejects cyclic requirement dependencies", () => {
  assert.throws(
    () =>
      new SageRouter(
        [{ agentId: "current", skills: { plan: 1 }, cost: 0.02, latencyMs: 300 }],
        "current",
      ).route({
        taskId: "cycle",
        requirements: [
          { name: "plan", dependsOn: ["build"] },
          { name: "build", dependsOn: ["plan"] },
        ],
      }),
    /must form a DAG/,
  );
});

test("assigns DAG roles and exposes cross-agent topology", () => {
  const agents: SageAgent[] = [
    { agentId: "planner", skills: { plan: 0.98, build: 0.1 }, cost: 0.02, latencyMs: 600 },
    { agentId: "builder", skills: { plan: 0.1, build: 0.99 }, cost: 0.03, latencyMs: 700 },
  ];
  const task: SageTask = {
    taskId: "dag",
    requirements: [
      { name: "plan", weight: 0.35, minimum: 0.75 },
      { name: "build", weight: 0.65, minimum: 0.75, dependsOn: ["plan"] },
    ],
    budget: 0.2,
    deadlineMs: 3000,
    coordinationOverhead: 0.02,
  };

  const decision = new SageRouter(agents, "planner").route(task);

  assert.equal(decision.mode, "collaborate");
  assert.deepEqual(decision.assignments, { plan: "planner", build: "builder" });
  assert.ok(
    decision.topology.some(
      ([left, right]) => left === "planner" && right === "builder",
    ),
  );
});

test("enforces the team deadline after DAG scheduling", () => {
  const agents: SageAgent[] = [
    { agentId: "planner", skills: { plan: 0.98, build: 0.05 }, cost: 0.02, latencyMs: 800 },
    { agentId: "builder", skills: { plan: 0.05, build: 0.99 }, cost: 0.02, latencyMs: 800 },
  ];
  const task: SageTask = {
    taskId: "tight-dag",
    requirements: [
      { name: "plan", weight: 0.5, minimum: 0.7 },
      { name: "build", weight: 0.5, minimum: 0.7, dependsOn: ["plan"] },
    ],
    budget: 0.2,
    deadlineMs: 1200,
    coordinationOverhead: 1,
  };

  const decision = new SageRouter(agents, "planner").route(task);

  assert.notEqual(decision.mode, "collaborate");
  assert.ok(decision.latencyMs <= task.deadlineMs!);
});

test("updates reliability and pair synergy from execution evidence", () => {
  const agents: SageAgent[] = [
    { agentId: "current", skills: { planning: 0.9, coding: 0.2 }, cost: 0.02, latencyMs: 300 },
    { agentId: "coder", skills: { planning: 0.2, coding: 0.9 }, cost: 0.02, latencyMs: 350 },
  ];
  const task: SageTask = {
    taskId: "learn",
    requirements: [
      { name: "planning", weight: 0.5 },
      { name: "coding", weight: 0.5 },
    ],
    budget: 0.2,
    deadlineMs: 2000,
    coordinationOverhead: 0.01,
  };
  const router = new SageRouter(agents, "current");
  const decision = router.route(task);
  const before = router.reliability.get("current")!.mean;

  router.recordOutcome(decision, true);

  assert.ok(router.reliability.get("current")!.mean > before);
  if (decision.agents.length > 1) {
    const pair = [...decision.agents].sort().join("\u0000");
    assert.ok(router.synergy.get(pair)!.mean > 0.5);
  }
});

test("keeps contextual reliability isolated by requirement", () => {
  const router = new SageRouter(
    [{ agentId: "current", skills: { code: 0.9, writing: 0.9 }, cost: 0.02, latencyMs: 300 }],
    "current",
  );
  const codeTask: SageTask = {
    taskId: "code",
    requirements: [{ name: "code" }],
    budget: 0.2,
    deadlineMs: 2000,
  };
  const codeDecision = router.route(codeTask);

  router.recordOutcome(codeDecision, {
    success: false,
    requirementScores: { code: 0 },
  });

  router.route({
    taskId: "writing",
    requirements: [{ name: "writing" }],
    budget: 0.2,
    deadlineMs: 2000,
  });
  assert.ok(router.skillReliability.get("current\u0000code")!.mean < 0.5);
  assert.equal(router.skillReliability.get("current\u0000writing")!.mean, 0.5);
});

test("assigns explicit partial credit to different agents", () => {
  const agents: SageAgent[] = [
    { agentId: "current", skills: { plan: 0.98, code: 0.05 }, cost: 0.02, latencyMs: 300 },
    { agentId: "coder", skills: { plan: 0.05, code: 0.99 }, cost: 0.02, latencyMs: 350 },
  ];
  const task: SageTask = {
    taskId: "credit",
    requirements: [
      { name: "plan", weight: 0.5 },
      { name: "code", weight: 0.5 },
    ],
    budget: 0.2,
    deadlineMs: 2000,
    coordinationOverhead: 0.01,
  };
  const router = new SageRouter(agents, "current");
  const decision = router.route(task);

  router.recordOutcome(decision, {
    success: 0.5,
    agentScores: { current: 1, coder: 0 },
  });

  assert.ok(router.reliability.get("current")!.mean > 0.5);
  assert.ok(router.reliability.get("coder")!.mean < 0.5);
  assert.equal(router.successModel.updates, 1);
});

test("rejects outcome evidence for unselected agents", () => {
  const agents: SageAgent[] = [
    { agentId: "current", skills: { code: 0.9 }, cost: 0.02, latencyMs: 300 },
    { agentId: "peer", skills: { code: 0.8 }, cost: 0.03, latencyMs: 350 },
  ];
  const router = new SageRouter(agents, "current");
  const decision = router.route({
    taskId: "evidence",
    requirements: [{ name: "code" }],
    budget: 0.2,
    deadlineMs: 2000,
  });

  assert.throws(
    () =>
      router.recordOutcome(decision, {
        success: 1,
        agentScores: { "not-selected": 1 },
      }),
    /unselected agents/,
  );
});

test("rejects invalid outcome scores and realized metrics", () => {
  const router = new SageRouter(
    [{ agentId: "current", skills: { code: 0.9 }, cost: 0.02, latencyMs: 300 }],
    "current",
  );
  const decision = router.route({
    taskId: "invalid-outcome",
    requirements: [{ name: "code" }],
    budget: 0.2,
    deadlineMs: 2000,
  });

  assert.throws(
    () =>
      router.recordOutcome(decision, {
        success: 1.1,
      }),
    /outcome scores/,
  );
  assert.throws(
    () =>
      router.recordOutcome(decision, {
        success: 1,
        actualCost: -0.1,
      }),
    /actual_cost/,
  );
});

test("replans away from a failed incumbent", () => {
  const agents: SageAgent[] = [
    { agentId: "current", skills: { code: 0.8 }, cost: 0.02, latencyMs: 300 },
    { agentId: "peer", skills: { code: 0.9 }, cost: 0.03, latencyMs: 350 },
  ];
  const task: SageTask = {
    taskId: "recover",
    requirements: [{ name: "code" }],
    budget: 0.2,
    deadlineMs: 2000,
  };
  const state = {
    activeAgents: ["current"],
    activeMode: "self" as const,
    progress: 0.45,
    failedAgents: new Set(["current"]),
    failureCount: 1,
  };

  const decision = new SageRouter(agents, "current").route(task, undefined, state);

  assert.equal(decision.mode, "handoff");
  assert.deepEqual(decision.agents, ["peer"]);
  assert.equal(decision.switchRecommended, true);
});

for (const fixture of routeFixtures) {
  test("matches the independent route fixture: " + fixture.name, () => {
    const decision = new SageRouter(fixture.agents, fixture.incumbentId).route(
      fixture.task,
    );

    assert.equal(decision.mode, fixture.expectedMode);
    assert.deepEqual([...decision.agents].sort(), [...fixture.expectedAgents].sort());
  });
}
