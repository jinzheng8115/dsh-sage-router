import { deepStrictEqual, equal } from "node:assert/strict";
import test from "node:test";

import {
  DagRunner,
  type SageDagAssignment,
} from "../src/execution/dag-runner.js";
import { DefaultSageOrchestrator } from "../src/execution/orchestrator.js";
import { createAgentCatalog } from "../src/harness/agent-catalog.js";
import type {
  HarnessAgentRef,
  SageSubagentGateway,
  SageSubagentResult,
  SageSubagentRun,
} from "../src/harness/subagent-gateway.js";
import { ContextSubagentGateway as NativeGateway } from "../src/harness/subagent-gateway.js";
import type { SageDecision, SageTask } from "../src/core/types.js";

test("runs independent DAG requirements for different agents concurrently", async () => {
  const gateway = new TimedGateway();
  const runner = new DagRunner(gateway);
  const parent: HarnessAgentRef = { sessionId: "root", provider: "local" };
  const assignments: readonly SageDagAssignment[] = [
    assignment("research", "agent-a"),
    assignment("review", "agent-b"),
  ];

  const result = await runner.execute(assignments, parent, new AbortController().signal);

  equal(result.status, "completed");
  equal(gateway.maxActive, 2);
  deepStrictEqual(
    result.requirementResults.map((item) => item.requirement),
    ["research", "review"],
  );
  equal(gateway.disposed, 2);
});

test("serializes one agent while releasing dependent work after its prerequisite", async () => {
  const gateway = new TimedGateway();
  const runner = new DagRunner(gateway);
  const parent: HarnessAgentRef = { sessionId: "root", provider: "local" };

  const result = await runner.execute(
    [
      assignment("prepare", "agent-a"),
      assignment("write", "agent-a"),
      {
        ...assignment("review", "agent-b"),
        requirement: { name: "review", dependsOn: ["prepare"] },
      },
    ],
    parent,
    new AbortController().signal,
  );

  equal(result.status, "completed");
  equal(gateway.sameAgentOverlap, false);
  equal(gateway.started.indexOf("prepare") < gateway.started.indexOf("review"), true);
  equal(gateway.started.indexOf("prepare") < gateway.started.indexOf("write"), true);
  equal(gateway.disposed, 3);
});

test("SELF returns a continuation request without starting a child", async () => {
  const gateway = new TimedGateway();
  const orchestrator = new DefaultSageOrchestrator({
    catalog: createAgentCatalog({
      agents: [
        {
          agentId: "self",
          provider: "local",
          skills: { general: 1 },
          cost: 1,
          latencyMs: 1,
        },
      ],
      incumbentId: "self",
      maxCollaborators: 0,
      beamWidth: 1,
      exploration: false,
      defaultDeadlineMs: 1000,
      defaultBudget: 1,
      autoOrchestrate: true,
      sessionEventLog: false,
    }),
    gateway,
  });

  const result = await orchestrator.execute(
    task("self-task", "general"),
    decision("self", "self", "general"),
    { sessionId: "root", provider: "local" },
    new AbortController().signal,
  );

  equal(result.status, "self");
  equal(result.continuation?.agentId, "root");
  equal(result.outcome, undefined);
  equal(gateway.started.length, 0);
});

test("COLLABORATE aggregates structured child scores", async () => {
  const gateway = new TimedGateway();
  const orchestrator = new DefaultSageOrchestrator({
    catalog: createAgentCatalog({
      agents: [
        {
          agentId: "researcher",
          provider: "remote",
          skills: { research: 1 },
          cost: 1,
          latencyMs: 1,
        },
        {
          agentId: "reviewer",
          provider: "remote",
          skills: { review: 1 },
          cost: 1,
          latencyMs: 1,
        },
      ],
      incumbentId: "researcher",
      maxCollaborators: 2,
      beamWidth: 1,
      exploration: false,
      defaultDeadlineMs: 1000,
      defaultBudget: 10,
      autoOrchestrate: true,
      sessionEventLog: false,
    }),
    gateway,
  });

  const result = await orchestrator.execute(
    {
      taskId: "collaboration",
      requirements: [{ name: "research" }, { name: "review" }],
    },
    {
      ...decision("collaborate", "researcher", "research"),
      agents: ["researcher", "reviewer"],
      assignments: { research: "researcher", review: "reviewer" },
    },
    { sessionId: "root", provider: "local" },
    new AbortController().signal,
  );

  equal(result.status, "completed");
  equal(result.outcome?.success, true);
  deepStrictEqual(result.outcome?.requirementScores, { research: 1, review: 1 });
  equal(gateway.maxActive, 2);
});

test("HANDOFF replans after child start failure without losing the incumbent", async () => {
  const gateway = new FailingGateway();
  let replannedState: Parameters<NonNullable<ConstructorParameters<typeof DefaultSageOrchestrator>[0]["replan"]>>[1] | undefined;
  const orchestrator = new DefaultSageOrchestrator({
    catalog: createAgentCatalog({
      agents: [
        {
          agentId: "self",
          provider: "local",
          skills: { handoff: 0.2 },
          cost: 1,
          latencyMs: 1,
        },
        {
          agentId: "specialist",
          provider: "remote",
          skills: { handoff: 1 },
          cost: 1,
          latencyMs: 1,
        },
      ],
      incumbentId: "self",
      maxCollaborators: 1,
      beamWidth: 1,
      exploration: false,
      defaultDeadlineMs: 1000,
      defaultBudget: 10,
      autoOrchestrate: true,
      sessionEventLog: false,
    }),
    gateway,
    replan: (_task, state) => {
      replannedState = state;
      return decision("self", "self", "handoff");
    },
  });

  const result = await orchestrator.execute(
    task("handoff", "handoff"),
    decision("handoff", "specialist", "handoff"),
    { sessionId: "self", provider: "local" },
    new AbortController().signal,
  );

  equal(result.status, "replanned");
  equal(result.nextDecision?.mode, "self");
  equal(replannedState?.activeMode, "handoff");
  equal(replannedState?.failureCount, 1);
  equal(hasAgent(replannedState?.failedAgents, "specialist"), true);
  equal(hasAgent(replannedState?.activeAgents, "self"), true);
  equal(gateway.started.length, 1);
});

test("aborting a DAG interrupts and disposes unfinished children", async () => {
  const gateway = new HangingGateway();
  const runner = new DagRunner(gateway);
  const controller = new AbortController();
  const execution = runner.execute(
    [assignment("long-task", "agent-a")],
    { sessionId: "root", provider: "local" },
    controller.signal,
  );

  await gateway.started;
  controller.abort();
  const result = await execution;

  equal(result.status, "aborted");
  equal(gateway.interrupted, 1);
  equal(gateway.disposed, 1);
});

test("ctx.subagents adapter forwards execution policy and normalizes structured output", async () => {
  let providerName = "";
  let forwarded: Record<string, unknown> | undefined;
  let disposed = 0;
  const native = {
    start: async (
      provider: string,
      request: Record<string, unknown>,
    ) => {
      providerName = provider;
      forwarded = request;
      return {
        id: "native-run",
        result: Promise.resolve({
          stopReason: "completed",
          structured: {
            requirementResults: [{ requirement: "research", score: 0.9 }],
          },
        }),
        dispose: async () => {
          disposed += 1;
        },
      };
    },
  } as ConstructorParameters<typeof NativeGateway>[0];
  const gateway = new NativeGateway(native);
  const parent: HarnessAgentRef = {
    sessionId: "parent",
    provider: "local",
    agent: { id: "parent-agent" },
  };

  const run = await gateway.start({
    requirement: "research",
    agentId: "researcher",
    provider: "remote-model-provider",
    subagentProvider: "spawn",
    model: "research-model",
    parent,
    prompt: [{ type: "text", text: "research" }],
    outputSchema: { type: "object", properties: { requirementResults: { type: "array" } } },
    toolFilter: { allow: ["read_file"] },
    maxDepth: 1,
    signal: new AbortController().signal,
  });
  const result = await run.result;

  equal(providerName, "spawn");
  equal((forwarded?.parent as { id: string }).id, "parent-agent");
  equal((forwarded?.agentOptions as { model: string }).model, "research-model");
  deepStrictEqual(forwarded?.toolFilter, { allow: ["read_file"] });
  equal(forwarded?.maxDepth, 1);
  equal(result.status, "completed");
  equal(result.requirementResults[0]?.score, 0.9);
  await run.dispose();
  equal(disposed, 1);
});

function assignment(requirement: string, agentId: string): SageDagAssignment {
  return {
    requirement: { name: requirement },
    agentId,
    provider: "spawn",
    prompt: [{ type: "text", text: requirement }],
  };
}

function task(taskId: string, requirement: string): SageTask {
  return { taskId, requirements: [{ name: requirement }] };
}

function decision(mode: SageDecision["mode"], agentId: string, requirement: string): SageDecision {
  return {
    mode,
    agents: [agentId],
    utility: 1,
    successProbability: 1,
    coverage: 1,
    cost: 1,
    latencyMs: 1,
    risk: 0,
    explanation: "test",
    assignments: { [requirement]: agentId },
    topology: [],
    switchRecommended: false,
    diagnostics: {},
    modelFeatures: {},
  };
}

function hasAgent(values: readonly string[] | ReadonlySet<string> | undefined, agentId: string): boolean {
  if (values === undefined) return false;
  return Array.isArray(values)
    ? (values as readonly string[]).includes(agentId)
    : (values as ReadonlySet<string>).has(agentId);
}

class TimedGateway implements SageSubagentGateway {
  active = 0;
  maxActive = 0;
  disposed = 0;
  sameAgentOverlap = false;
  started: string[] = [];
  private readonly activeAgents = new Set<string>();

  async start(input: Parameters<SageSubagentGateway["start"]>[0]): Promise<SageSubagentRun> {
    this.started.push(input.requirement);
    if (this.activeAgents.has(input.agentId)) this.sameAgentOverlap = true;
    this.activeAgents.add(input.agentId);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let disposed = false;
    const result = new Promise<SageSubagentResult>((resolve) => {
      setTimeout(() => {
        resolve({
          status: "completed",
          requirementResults: [{ requirement: input.requirement, score: 1 }],
        });
      }, 10);
    });
    return {
      id: input.requirement,
      result,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        this.activeAgents.delete(input.agentId);
        this.active -= 1;
        this.disposed += 1;
      },
    };
  }

  async interrupt(): Promise<void> {}
}

class FailingGateway implements SageSubagentGateway {
  started: string[] = [];

  async start(input: Parameters<SageSubagentGateway["start"]>[0]): Promise<SageSubagentRun> {
    this.started.push(input.requirement);
    throw new Error("child start failed");
  }

  async interrupt(): Promise<void> {}
}

class HangingGateway implements SageSubagentGateway {
  readonly started: Promise<void>;
  interrupted = 0;
  disposed = 0;
  private markStarted!: () => void;
  private resolveResult!: (result: SageSubagentResult) => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async start(input: Parameters<SageSubagentGateway["start"]>[0]): Promise<SageSubagentRun> {
    this.markStarted();
    const result = new Promise<SageSubagentResult>((resolve) => {
      this.resolveResult = resolve;
    });
    return {
      id: input.requirement,
      result,
      dispose: async () => {
        this.disposed += 1;
        this.resolveResult({ status: "aborted", requirementResults: [] });
      },
    };
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1;
    this.resolveResult({ status: "aborted", requirementResults: [] });
  }
}
