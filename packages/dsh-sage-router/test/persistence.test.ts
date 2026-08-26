import { deepStrictEqual, equal, match, rejects, throws } from "node:assert/strict";
import test from "node:test";

import { Session, SessionId } from "@deepseek-ai/dsh-session";

import {
  appendSageEvent,
  type SageEventAppender,
  type SageLearningState,
  type SageSessionLike,
  type SageStoredEvent,
} from "../src/persistence/events.js";
import { foldSageEvents } from "../src/persistence/fold.js";
import {
  InMemorySageLearningStore,
  openSageLearningStore,
  SageStaleRevisionError,
  type SageDomainFacility,
  type SageDomainHandle,
  type SageDomainSpec,
  type SageDomainTable,
} from "../src/persistence/learning-store.js";
import { SageRouter } from "../src/core/router.js";
import { SageRoutingService } from "../src/service.js";
import { parseSagePluginConfig } from "../src/config.js";
import type {
  SageSubagentGateway,
  SageSubagentRun,
} from "../src/harness/subagent-gateway.js";

class MemoryEventLog implements SageEventAppender {
  readonly events: SageStoredEvent[] = [];

  append(event: SageStoredEvent): void {
    this.events.push(event);
  }
}

class FailingEventLog implements SageEventAppender {
  append(): void {
    throw new Error("session write failed");
  }
}

class MemoryDomainTable implements SageDomainTable {
  private value: unknown;

  get(): unknown {
    return this.value;
  }

  async put(_key: string, value: unknown): Promise<void> {
    this.value = value;
  }

  async update(_key: string, update: (current: unknown) => unknown): Promise<unknown> {
    this.value = update(this.value);
    return this.value;
  }
}

class MemoryDomain implements SageDomainHandle {
  readonly tableValue = new MemoryDomainTable();
  closed = false;

  table(): SageDomainTable {
    return this.tableValue;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MemoryDomainFacility implements SageDomainFacility {
  spec: SageDomainSpec | undefined;
  readonly domain = new MemoryDomain();

  async open(spec: SageDomainSpec): Promise<SageDomainHandle> {
    this.spec = spec;
    return this.domain;
  }
}

const decision = {
  mode: "collaborate" as const,
  agents: ["self", "specialist"],
  utility: 0.71,
  successProbability: 0.82,
  coverage: 0.9,
  cost: 3,
  latencyMs: 120,
  risk: 0.18,
  explanation: "complementary skills",
  assignments: { plan: "self", build: "specialist" },
  topology: [["self", "specialist"]] as const,
  switchRecommended: false,
  diagnostics: { bottleneck: 0.8 },
  modelFeatures: { coverage: 0.9 },
};

const learningState: SageLearningState = {
  revision: 1,
  reliability: { self: { alpha: 3, beta: 2 } },
  skillReliability: { "self\u0000plan": { alpha: 4, beta: 1 } },
  synergy: {},
  costFidelity: { self: { alpha: 2, beta: 2 } },
  latencyFidelity: { self: { alpha: 2, beta: 2 } },
  successModel: {
    learningRate: 0.08,
    l2: 0.001,
    updates: 1,
    bias: -1,
    weights: { coverage: 2.35 },
  },
};

test("appends and replays SAGE route, execution, outcome, and model events", () => {
  const log = new MemoryEventLog();

  appendSageEvent(log, "sage/route", {
    routeId: "route-1",
    taskId: "task-1",
    decision,
    activeState: {
      activeAgents: ["self"],
      activeMode: "self",
      completedRequirements: new Set<string>(),
    },
  });
  appendSageEvent(log, "sage/execution", {
    routeId: "route-1",
    requirement: "plan",
    agentId: "self",
    status: "started",
  });
  appendSageEvent(log, "sage/execution", {
    routeId: "route-1",
    requirement: "plan",
    agentId: "self",
    status: "completed",
    score: 0.95,
  });
  appendSageEvent(log, "sage/outcome", {
    routeId: "route-1",
    outcome: {
      success: true,
      requirementScores: { plan: 0.95, build: 0.8 },
      actualCost: 2.5,
      actualLatencyMs: 110,
    },
  });
  appendSageEvent(log, "sage/model-update", {
    routeId: "route-1",
    state: learningState,
  });

  const folded = foldSageEvents(log.events);
  const route = folded.routes["route-1"];
  if (route === undefined) throw new Error("route was not folded");

  equal(route.taskId, "task-1");
  deepStrictEqual(route.decision.assignments, { plan: "self", build: "specialist" });
  equal(route.execution.plan.status, "completed");
  equal(route.outcome?.outcome.success, true);
  equal(folded.learningState?.revision, 1);
});

test("declared SAGE events append to a Harness session as log-only records", () => {
  const session = Session.create(SessionId("sage-persistence-session"));
  session.append("sage/route", {
    routeId: "route-session",
    taskId: "task-session",
    decision,
  });

  equal(session.events.length, 1);
  equal(session.events[0]?.type, "sage/route");
  equal(session.surface.nodes.length, 0);
  equal(foldSageEvents(session.events).routes["route-session"]?.taskId, "task-session");
});

test("session-log appends are gated behind sessionEventLog (default off)", () => {
  const baseConfig = {
    agents: [
      {
        agentId: "self",
        provider: "local",
        skills: { general: 0.9 },
        cost: 1,
        latencyMs: 100,
      },
    ],
    incumbentId: "self",
  };
  const defaultConfig = parseSagePluginConfig(baseConfig);
  equal(defaultConfig.sessionEventLog, false);

  const untouched = Session.create(SessionId("sage-gate-default"));
  const defaultService = new SageRoutingService(defaultConfig);
  equal(
    defaultService.sessionAppenderFor(untouched as unknown as SageSessionLike),
    undefined,
  );
  equal(untouched.events.length, 0);

  const optedInSession = Session.create(SessionId("sage-gate-optin"));
  const optedInService = new SageRoutingService(
    parseSagePluginConfig({ ...baseConfig, sessionEventLog: true }),
  );
  optedInService
    .sessionAppenderFor(optedInSession as unknown as SageSessionLike)
    ?.append({ type: "sage/route", data: { routeId: "route-gate", taskId: "task-gate", decision } });
  equal(optedInSession.events.length, 1);
  equal(optedInSession.events[0]?.type, "sage/route");
});

test("rejects unknown, incomplete, non-JSON, and invalid SAGE event payloads", () => {
  const log = new MemoryEventLog();

  throws(
    () => appendSageEvent(log, "sage/unknown" as never, {} as never),
    /unknown SAGE event type/,
  );
  throws(
    () => appendSageEvent(log, "sage/route", { taskId: "missing-route", decision } as never),
    /routeId/,
  );
  throws(
    () => appendSageEvent(log, "sage/execution", {
      routeId: "route-1",
      requirement: "plan",
      agentId: "self",
      status: "completed",
      score: 1.2,
    }),
    /score/,
  );
  throws(
    () => appendSageEvent(log, "sage/route", {
      routeId: "route-1",
      taskId: "task-1",
      decision: { ...decision, diagnostics: new Set(["secret"]) },
    } as never),
    /diagnostics must be an object|JSON-serializable/,
  );
  throws(
    () => foldSageEvents([{ type: "sage/unknown", data: {} }]),
    /unknown SAGE event type/,
  );
});

test("learning state updates use a compare-and-set revision", async () => {
  const store = new InMemorySageLearningStore();

  await store.save(0, learningState);
  await rejects(
    () => store.save(0, { ...learningState, revision: 2 }),
    (error: unknown) => error instanceof SageStaleRevisionError,
  );
  equal((await store.load())?.revision, 1);
});

test("storage-domain adapter persists the same revision contract", async () => {
  const facility = new MemoryDomainFacility();
  const handle = await openSageLearningStore(facility);

  await handle.store.save(0, learningState);
  equal((await handle.store.load())?.revision, 1);
  equal(facility.spec?.name, "sage_router_learning");
  await handle.close();
  equal(facility.domain.closed, true);
});

test("restoring a router keeps learned posterior and model update count", () => {
  const agents = [
    { agentId: "self", skills: { general: 0.9 }, cost: 1, latencyMs: 100 },
  ];
  const task = {
    taskId: "restore",
    requirements: [{ name: "general" }],
    budget: 10,
    deadlineMs: 10_000,
  };
  const original = new SageRouter(agents, "self");
  const routed = original.route(task);
  original.recordOutcome(routed, true);

  const restored = new SageRouter(agents, "self");
  restored.restoreLearningState(original.snapshotLearningState());

  equal(restored.successModel.updates, 1);
  equal(
    restored.reliability.get("self")?.mean,
    original.reliability.get("self")?.mean,
  );
  deepStrictEqual(restored.route(task).assignments, original.route(task).assignments);
});

test("service persists route and outcome updates and can hand the state to a new service", async () => {
  const config = parseSagePluginConfig({
    agents: [
      {
        agentId: "self",
        provider: "local",
        skills: { general: 0.9 },
        cost: 1,
        latencyMs: 100,
      },
    ],
    incumbentId: "self",
  });
  const events = new MemoryEventLog();
  const store = new InMemorySageLearningStore();
  const service = new SageRoutingService(config, undefined, {
    eventSink: events,
    learningStore: store,
  });
  const route = service.route({
    task: { taskId: "service-persist", requirements: [{ name: "general" }] },
  });

  service.recordOutcome(route.routeId, true);
  await service.flushPersistence();

  deepStrictEqual(
    events.events.map((event) => event.type),
    ["sage/route", "sage/outcome", "sage/model-update"],
  );
  equal((await store.load())?.revision, 1);

  const restored = new SageRoutingService(config, undefined, {
    learningState: await store.load(),
  });
  equal(restored.learningState().revision, 1);
  equal(restored.learningState().successModel.updates, 1);
  match(restored.route({
    task: { taskId: "service-restored", requirements: [{ name: "general" }] },
  }).routeId, /^[0-9a-f-]{36}$/);

  const replayed = new SageRoutingService(config);
  replayed.restoreSessionEvents(events.events);
  deepStrictEqual(replayed.getRoute(route.routeId)?.decision.assignments, route.decision.assignments);
  equal(replayed.learningState().revision, 1);
});

test("route does not report success when its session event cannot be appended", () => {
  const config = parseSagePluginConfig({
    agents: [
      {
        agentId: "self",
        provider: "local",
        skills: { general: 0.9 },
        cost: 1,
        latencyMs: 100,
      },
    ],
    incumbentId: "self",
  });
  const service = new SageRoutingService(config, undefined, {
    eventSink: new FailingEventLog(),
  });

  throws(
    () => service.route({ task: { taskId: "uncertain", requirements: [{ name: "general" }] } }),
    /SAGE_PERSISTENCE_UNCERTAIN/,
  );
});

test("service records execution lifecycle before learning outcome", async () => {
  const config = parseSagePluginConfig({
    agents: [
      {
        agentId: "self",
        provider: "local",
        skills: { security: 0.1 },
        cost: 1,
        latencyMs: 100,
      },
      {
        agentId: "specialist",
        provider: "remote",
        subagentProvider: "spawn",
        skills: { security: 0.99 },
        cost: 1,
        latencyMs: 100,
      },
    ],
    incumbentId: "self",
    autoOrchestrate: true,
  });
  const events = new MemoryEventLog();
  const store = new InMemorySageLearningStore();
  const gateway: SageSubagentGateway = {
    async start(input): Promise<SageSubagentRun> {
      return {
        id: input.requirement,
        result: Promise.resolve({
          status: "completed",
          requirementResults: [{ requirement: input.requirement, score: 0.95 }],
        }),
        dispose: async () => undefined,
      };
    },
    async interrupt(): Promise<void> {},
  };
  const service = new SageRoutingService(config, gateway, {
    eventSink: events,
    learningStore: store,
  });
  const route = service.route({
    task: {
      taskId: "execution-persist",
      requirements: [{ name: "security", minimum: 0.8 }],
    },
  });
  const result = await service.orchestrate(
    route.routeId,
    { sessionId: "parent", provider: "local" },
    new AbortController().signal,
  );

  equal(result.status, "completed");
  deepStrictEqual(
    events.events.map((event) => event.type),
    [
      "sage/route",
      "sage/execution",
      "sage/execution",
      "sage/outcome",
      "sage/model-update",
    ],
  );
  equal((await store.load())?.revision, 1);
});

test("two service instances cannot overwrite the same learning revision", async () => {
  const config = parseSagePluginConfig({
    agents: [
      {
        agentId: "self",
        provider: "local",
        skills: { general: 0.9 },
        cost: 1,
        latencyMs: 100,
      },
    ],
    incumbentId: "self",
  });
  const store = new InMemorySageLearningStore();
  const first = new SageRoutingService(config, undefined, { learningStore: store });
  const second = new SageRoutingService(config, undefined, { learningStore: store });
  const firstRoute = first.route({
    task: { taskId: "concurrent-first", requirements: [{ name: "general" }] },
  });
  const secondRoute = second.route({
    task: { taskId: "concurrent-second", requirements: [{ name: "general" }] },
  });
  first.recordOutcome(firstRoute.routeId, true);
  second.recordOutcome(secondRoute.routeId, false);

  const settled = await Promise.allSettled([
    first.flushPersistence(),
    second.flushPersistence(),
  ]);
  equal(settled.filter((item) => item.status === "rejected").length, 1);
  equal((await store.load())?.revision, 1);
});
