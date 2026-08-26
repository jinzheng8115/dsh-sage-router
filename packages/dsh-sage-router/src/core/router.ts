import {
  BetaBelief,
  OnlineSuccessModel,
  SeededRandom,
  clip,
} from "./beliefs.js";
import type {
  BetaBeliefSnapshot,
  SageAgent,
  SageBid,
  SageDecision,
  SageExecutionState,
  SageMode,
  SageOutcome,
  SageRequirement,
  SageRouterOptions,
  SageRouterLearningSnapshot,
  SageRouterWeights,
  SageTask,
} from "./types.js";

interface NormalizedRequirement {
  name: string;
  weight: number;
  minimum: number;
  dependsOn: readonly string[];
}

interface NormalizedTask {
  taskId: string;
  requirements: readonly NormalizedRequirement[];
  value: number;
  budget: number;
  deadlineMs: number;
  requiredPermissions: ReadonlySet<string>;
  riskTolerance: number;
  progress: number;
  handoffFriction: number;
  coordinationOverhead: number;
  contextTransferability: number;
  replanFriction: number;
}

interface NormalizedAgent {
  agentId: string;
  skills: Readonly<Record<string, number>>;
  cost: number;
  latencyMs: number;
  permissions: ReadonlySet<string>;
  availability: number;
  load: number;
}

interface NormalizedBid {
  agentId: string;
  taskId: string;
  quotedCost: number;
  promisedLatencyMs: number;
  confidence: number;
}

interface NormalizedState {
  activeAgents: readonly string[];
  activeMode: SageMode;
  completedRequirements: ReadonlySet<string>;
  progress: number | null;
  transferableContext: number | null;
  failedAgents: ReadonlySet<string>;
  failureCount: number;
}

interface CoverageResult {
  coverage: number;
  bottleneck: number;
  assignments: Record<string, string>;
  trust: number;
  uncertainty: number;
}

const DEFAULT_WEIGHTS: Required<SageRouterWeights> = {
  cost: 0.18,
  latency: 0.1,
  risk: 0.12,
  handoff: 0.22,
  coordination: 0.08,
  uncertainty: 0.05,
  exploration: 0.08,
};

function asSet(values: readonly string[] | ReadonlySet<string> | undefined): Set<string> {
  return new Set(values ?? []);
}

function assertUnit(value: number, label: string): void {
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error(label + " must be in [0, 1]");
  }
}

function assertPositive(value: number, label: string): void {
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(label + " must be positive");
  }
}

function assertNonNegative(value: number, label: string): void {
  if (Number.isNaN(value) || value < 0) {
    throw new Error(label + " must be non-negative");
  }
}

function normalizeRequirement(item: SageRequirement): NormalizedRequirement {
  if (!item.name) {
    throw new Error("requirement name must not be empty");
  }
  const weight = item.weight ?? 1;
  const minimum = item.minimum ?? 0.55;
  const dependsOn = [...(item.dependsOn ?? [])];
  assertPositive(weight, "requirement weight");
  assertUnit(minimum, "requirement minimum");
  if (dependsOn.includes(item.name)) {
    throw new Error("a requirement cannot depend on itself");
  }
  return { name: item.name, weight, minimum, dependsOn };
}

function validateDag(requirements: readonly NormalizedRequirement[]): void {
  const names = new Set(requirements.map((item) => item.name));
  if (names.size !== requirements.length) {
    throw new Error("requirement names must be unique");
  }
  const graph = new Map(requirements.map((item) => [item.name, item.dependsOn]));
  for (const item of requirements) {
    const unknown = item.dependsOn.filter((dependency) => !names.has(dependency));
    if (unknown.length > 0) {
      throw new Error("unknown requirement dependencies: " + unknown.join(", "));
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) {
      throw new Error("requirement dependencies must form a DAG");
    }
    if (visited.has(name)) {
      return;
    }
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) {
      visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
  };

  for (const item of requirements) {
    visit(item.name);
  }
}

function normalizeTask(task: SageTask): NormalizedTask {
  if (task.requirements.length === 0) {
    throw new Error("task must have at least one requirement");
  }
  const requirements = task.requirements.map(normalizeRequirement);
  validateDag(requirements);

  const value = task.value ?? 1;
  const budget = task.budget ?? Number.POSITIVE_INFINITY;
  const deadlineMs = task.deadlineMs ?? Number.POSITIVE_INFINITY;
  const riskTolerance = task.riskTolerance ?? 0.5;
  const progress = task.progress ?? 0;
  const handoffFriction = task.handoffFriction ?? 0.25;
  const coordinationOverhead = task.coordinationOverhead ?? 0.06;
  const contextTransferability = task.contextTransferability ?? 0.7;
  const replanFriction = task.replanFriction ?? 0.03;

  assertPositive(value, "value");
  assertPositive(budget, "budget");
  assertPositive(deadlineMs, "deadline");
  assertUnit(riskTolerance, "risk_tolerance");
  assertUnit(progress, "progress");
  assertUnit(contextTransferability, "context_transferability");
  assertNonNegative(handoffFriction, "handoff_friction");
  assertNonNegative(coordinationOverhead, "coordination_overhead");
  assertNonNegative(replanFriction, "replan_friction");

  return {
    taskId: task.taskId,
    requirements,
    value,
    budget,
    deadlineMs,
    requiredPermissions: asSet(task.requiredPermissions),
    riskTolerance,
    progress,
    handoffFriction,
    coordinationOverhead,
    contextTransferability,
    replanFriction,
  };
}

function normalizeAgent(agent: SageAgent): NormalizedAgent {
  if (!agent.agentId) {
    throw new Error("agent_id must not be empty");
  }
  assertNonNegative(agent.cost, "cost");
  assertNonNegative(agent.latencyMs, "latency");
  const availability = agent.availability ?? 1;
  const load = agent.load ?? 0;
  assertUnit(availability, "availability");
  assertUnit(load, "load");
  for (const score of Object.values(agent.skills)) {
    assertUnit(score, "skill score");
  }
  return {
    agentId: agent.agentId,
    skills: { ...agent.skills },
    cost: agent.cost,
    latencyMs: agent.latencyMs,
    permissions: asSet(agent.permissions),
    availability,
    load,
  };
}

function normalizeState(state?: SageExecutionState): NormalizedState {
  const progress = state?.progress ?? null;
  const transferableContext = state?.transferableContext ?? null;
  if (progress !== null) {
    assertUnit(progress, "state progress");
  }
  if (transferableContext !== null) {
    assertUnit(transferableContext, "transferable_context");
  }
  const failureCount = state?.failureCount ?? 0;
  if (!Number.isInteger(failureCount) || failureCount < 0) {
    throw new Error("failure_count must be non-negative");
  }
  return {
    activeAgents: [...(state?.activeAgents ?? [])],
    activeMode: state?.activeMode ?? "self",
    completedRequirements: asSet(state?.completedRequirements),
    progress,
    transferableContext,
    failedAgents: asSet(state?.failedAgents),
    failureCount,
  };
}

function normalizeBid(bid: SageBid): NormalizedBid {
  assertNonNegative(bid.quotedCost, "bid cost");
  assertNonNegative(bid.promisedLatencyMs, "bid latency");
  const confidence = bid.confidence ?? 0.7;
  assertUnit(confidence, "bid confidence");
  return {
    agentId: bid.agentId,
    taskId: bid.taskId,
    quotedCost: bid.quotedCost,
    promisedLatencyMs: bid.promisedLatencyMs,
    confidence,
  };
}

function normalizeOutcome(outcome: SageOutcome | number | boolean): SageOutcome {
  const evidence: SageOutcome =
    typeof outcome === "object" && outcome !== null
      ? outcome
      : { success: outcome };
  const scores = [
    Number(evidence.success),
    ...Object.values(evidence.agentScores ?? {}),
    ...Object.values(evidence.requirementScores ?? {}),
  ];
  if (scores.some((value) => Number.isNaN(value) || value < 0 || value > 1)) {
    throw new Error("outcome scores must be in [0, 1]");
  }
  if (evidence.actualCost != null) {
    assertNonNegative(evidence.actualCost, "actual_cost");
  }
  if (evidence.actualLatencyMs != null) {
    assertNonNegative(evidence.actualLatencyMs, "actual_latency_ms");
  }
  return evidence;
}

function sortedPair(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}

function setEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function assertBeliefSnapshot(
  snapshot: BetaBeliefSnapshot,
  label: string,
): void {
  if (
    !Number.isFinite(snapshot.alpha) ||
    !Number.isFinite(snapshot.beta) ||
    snapshot.alpha <= 0 ||
    snapshot.beta <= 0
  ) {
    throw new Error(`${label} must contain positive finite alpha and beta`);
  }
}

function assertSnapshotRecord(
  value: unknown,
  label: string,
): asserts value is Readonly<Record<string, BetaBeliefSnapshot>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [key, snapshot] of Object.entries(value)) {
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error(`${label}.${key} must be a belief snapshot`);
    }
    assertBeliefSnapshot(snapshot as BetaBeliefSnapshot, `${label}.${key}`);
  }
}

function snapshotBeliefs(
  beliefs: ReadonlyMap<string, BetaBelief>,
): Record<string, BetaBeliefSnapshot> {
  return Object.fromEntries(
    [...beliefs.entries()].map(([key, belief]) => [key, belief.snapshot()]),
  );
}

export class SageRouter {
  private readonly agentMap: Map<string, NormalizedAgent>;
  private readonly weights: Required<SageRouterWeights>;
  private readonly maxCollaborators: number;
  private readonly beamWidth: number;
  private readonly exploration: boolean;
  private readonly random: SeededRandom;
  private readonly drawCache = new Map<string, number>();

  public readonly reliability = new Map<string, BetaBelief>();
  public readonly skillReliability = new Map<string, BetaBelief>();
  public readonly synergy = new Map<string, BetaBelief>();
  public readonly costFidelity = new Map<string, BetaBelief>();
  public readonly latencyFidelity = new Map<string, BetaBelief>();
  public readonly successModel = new OnlineSuccessModel();

  public constructor(
    agents: readonly SageAgent[],
    private readonly incumbentId: string,
    options: SageRouterOptions = {},
  ) {
    this.agentMap = new Map();
    for (const input of agents) {
      const agent = normalizeAgent(input);
      if (this.agentMap.has(agent.agentId)) {
        throw new Error("duplicate agent_id: " + agent.agentId);
      }
      this.agentMap.set(agent.agentId, agent);
      this.reliability.set(agent.agentId, new BetaBelief());
      this.costFidelity.set(agent.agentId, new BetaBelief());
      this.latencyFidelity.set(agent.agentId, new BetaBelief());
    }
    if (!this.agentMap.has(incumbentId)) {
      throw new Error("incumbent_id must identify a registered agent");
    }

    this.weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
    this.maxCollaborators = options.maxCollaborators ?? 2;
    this.beamWidth = options.beamWidth ?? 8;
    this.exploration = options.exploration ?? false;
    this.random = new SeededRandom(options.seed ?? 7);
    if (this.maxCollaborators < 0 || this.beamWidth <= 0) {
      throw new Error(
        "max_collaborators must be non-negative and beam_width positive",
      );
    }
  }

  public route(
    taskInput: SageTask,
    bidsInput?: readonly SageBid[],
    stateInput?: SageExecutionState,
  ): SageDecision {
    const task = normalizeTask(taskInput);
    const state = normalizeState(stateInput);
    this.validateState(task, state);
    this.drawCache.clear();
    const bids = this.prepareBids(task, bidsInput);
    const eligible = [...this.agentMap.values()]
      .filter(
        (agent) =>
          !state.failedAgents.has(agent.agentId) &&
          this.eligible(agent, task, bids.get(agent.agentId)!),
      )
      .map((agent) => agent.agentId);

    if (eligible.length === 0) {
      throw new Error(
        "no eligible agent satisfies permissions, budget, and deadline",
      );
    }

    const decisions: SageDecision[] = [];
    if (eligible.includes(this.incumbentId)) {
      const selfDecision = this.evaluate(
        "self",
        [this.incumbentId],
        task,
        bids,
        state,
      );
      if (this.teamFeasible(selfDecision, task)) {
        decisions.push(selfDecision);
      }
      decisions.push(...this.beamCollaborationDecisions(task, eligible, bids, state));
    }

    for (const agentId of eligible) {
      if (agentId === this.incumbentId) {
        continue;
      }
      const handoff = this.evaluate("handoff", [agentId], task, bids, state);
      if (this.teamFeasible(handoff, task)) {
        decisions.push(handoff);
      }
    }

    if (decisions.length === 0) {
      throw new Error(
        "no feasible route satisfies team-level budget and deadline constraints",
      );
    }

    const best = decisions.reduce((current, candidate) =>
      candidate.utility > current.utility ? candidate : current,
    );
    const switched =
      state.activeAgents.length > 0 &&
      (best.mode !== state.activeMode ||
        !setEquals(best.agents, state.activeAgents));
    return { ...best, switchRecommended: switched };
  }

  public recordOutcome(
    decision: SageDecision,
    outcome: SageOutcome | number | boolean,
  ): void {
    const evidence = normalizeOutcome(outcome);
    const agentScores = evidence.agentScores ?? {};
    const requirementScores = evidence.requirementScores ?? {};
    const unknownAgents = Object.keys(agentScores).filter(
      (agentId) => !decision.agents.includes(agentId),
    );
    const unknownRequirements = Object.keys(requirementScores).filter(
      (name) => !(name in decision.assignments),
    );
    if (unknownAgents.length > 0) {
      throw new Error(
        "outcome contains unselected agents: " + unknownAgents.join(", "),
      );
    }
    if (unknownRequirements.length > 0) {
      throw new Error(
        "outcome contains unknown requirements: " +
          unknownRequirements.join(", "),
      );
    }

    const overall = clip(Number(evidence.success));
    this.successModel.update(decision.modelFeatures, overall);
    const assignedByAgent = new Map<string, string[]>(
      decision.agents.map((agentId) => [agentId, []]),
    );
    for (const [requirement, agentId] of Object.entries(decision.assignments)) {
      const assigned = assignedByAgent.get(agentId);
      if (assigned) {
        assigned.push(requirement);
      }
    }

    const attributedScores = new Map<string, number>();
    for (const agentId of decision.agents) {
      const explicit = agentScores[agentId];
      const assignedScores = (assignedByAgent.get(agentId) ?? [])
        .filter((name) => Object.prototype.hasOwnProperty.call(requirementScores, name))
        .map((name) => requirementScores[name]);
      let credit: number;
      let weight: number;
      if (explicit !== undefined) {
        credit = explicit;
        weight = 1;
      } else if (assignedScores.length > 0) {
        credit =
          assignedScores.reduce((sum, value) => sum + value, 0) /
          assignedScores.length;
        weight = 0.85;
      } else {
        credit = overall;
        weight = 0.35;
      }
      attributedScores.set(agentId, clip(credit));
      this.reliability.get(agentId)!.update(credit, weight);

      for (const requirement of assignedByAgent.get(agentId) ?? []) {
        const hasScore = Object.prototype.hasOwnProperty.call(
          requirementScores,
          requirement,
        );
        const skillScore = hasScore ? requirementScores[requirement] : credit;
        this.getSkillBelief(agentId, requirement).update(
          skillScore,
          hasScore ? 1 : weight,
        );
      }
    }

    const team = [...decision.agents].sort();
    for (let leftIndex = 0; leftIndex < team.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < team.length;
        rightIndex += 1
      ) {
        const left = team[leftIndex];
        const right = team[rightIndex];
        if (left === undefined || right === undefined) {
          continue;
        }
        let pairCredit: number;
        let pairWeight: number;
        if (
          Object.keys(agentScores).length > 0 ||
          Object.keys(requirementScores).length > 0
        ) {
          const individualMean =
            ((attributedScores.get(left) ?? overall) +
              (attributedScores.get(right) ?? overall)) /
            2;
          pairCredit = clip(0.5 + overall - individualMean);
          pairWeight = 0.7;
        } else {
          pairCredit = overall;
          pairWeight = 0.25;
        }
        this.getSynergyBelief(left, right).update(pairCredit, pairWeight);
      }
    }

    if (evidence.actualCost != null && decision.cost > 0) {
      const fidelity = clip(
        1 - Math.max(0, evidence.actualCost / decision.cost - 1),
      );
      for (const agentId of decision.agents) {
        this.costFidelity.get(agentId)!.update(fidelity);
      }
    }
    if (evidence.actualLatencyMs != null && decision.latencyMs > 0) {
      const fidelity = clip(
        1 - Math.max(0, evidence.actualLatencyMs / decision.latencyMs - 1),
      );
      for (const agentId of decision.agents) {
        this.latencyFidelity.get(agentId)!.update(fidelity);
      }
    }
  }

  public snapshotLearningState(): SageRouterLearningSnapshot {
    return {
      reliability: snapshotBeliefs(this.reliability),
      skillReliability: snapshotBeliefs(this.skillReliability),
      synergy: snapshotBeliefs(this.synergy),
      costFidelity: snapshotBeliefs(this.costFidelity),
      latencyFidelity: snapshotBeliefs(this.latencyFidelity),
      successModel: this.successModel.snapshot(),
    };
  }

  public restoreLearningState(
    snapshot: SageRouterLearningSnapshot,
  ): void {
    assertSnapshotRecord(snapshot.reliability, "reliability");
    assertSnapshotRecord(snapshot.skillReliability, "skillReliability");
    assertSnapshotRecord(snapshot.synergy, "synergy");
    assertSnapshotRecord(snapshot.costFidelity, "costFidelity");
    assertSnapshotRecord(snapshot.latencyFidelity, "latencyFidelity");

    const knownAgents = new Set(this.agentMap.keys());
    const validateAgentKeys = (
      values: Readonly<Record<string, BetaBeliefSnapshot>>,
      label: string,
    ): void => {
      for (const agentId of Object.keys(values)) {
        if (!knownAgents.has(agentId)) {
          throw new Error(`${label} contains unknown agent: ${agentId}`);
        }
      }
    };
    validateAgentKeys(snapshot.reliability, "reliability");
    validateAgentKeys(snapshot.costFidelity, "costFidelity");
    validateAgentKeys(snapshot.latencyFidelity, "latencyFidelity");

    for (const key of Object.keys(snapshot.skillReliability)) {
      const [agentId, requirement, ...rest] = key.split("\u0000");
      if (!agentId || !requirement || rest.length > 0 || !knownAgents.has(agentId)) {
        throw new Error(`skillReliability contains an invalid key: ${key}`);
      }
    }
    for (const key of Object.keys(snapshot.synergy)) {
      const [left, right, ...rest] = key.split("\u0000");
      if (
        !left ||
        !right ||
        rest.length > 0 ||
        left >= right ||
        !knownAgents.has(left) ||
        !knownAgents.has(right)
      ) {
        throw new Error(`synergy contains an invalid key: ${key}`);
      }
    }

    const model = snapshot.successModel;
    if (
      !Number.isFinite(model.learningRate) ||
      model.learningRate <= 0 ||
      !Number.isFinite(model.l2) ||
      model.l2 < 0 ||
      !Number.isInteger(model.updates) ||
      model.updates < 0 ||
      !Number.isFinite(model.bias)
    ) {
      throw new Error("successModel contains invalid scalar values");
    }
    for (const [name, value] of Object.entries(model.weights)) {
      if (!Number.isFinite(value)) {
        throw new Error(`successModel weight is not finite: ${name}`);
      }
    }

    const restore = (
      target: Map<string, BetaBelief>,
      values: Readonly<Record<string, BetaBeliefSnapshot>>,
      defaults: readonly string[] = [],
    ): void => {
      target.clear();
      for (const key of defaults) {
        target.set(key, new BetaBelief());
      }
      for (const [key, value] of Object.entries(values)) {
        target.set(key, BetaBelief.fromSnapshot(value));
      }
    };
    const agentIds = [...knownAgents];
    restore(this.reliability, snapshot.reliability, agentIds);
    restore(this.costFidelity, snapshot.costFidelity, agentIds);
    restore(this.latencyFidelity, snapshot.latencyFidelity, agentIds);
    restore(this.skillReliability, snapshot.skillReliability);
    restore(this.synergy, snapshot.synergy);
    this.successModel.learningRate = model.learningRate;
    this.successModel.l2 = model.l2;
    this.successModel.updates = model.updates;
    this.successModel.bias = model.bias;
    this.successModel.weights = { ...model.weights };
  }

  private validateState(task: NormalizedTask, state: NormalizedState): void {
    const requirementNames = new Set(task.requirements.map((item) => item.name));
    const unknownRequirements = [...state.completedRequirements].filter(
      (name) => !requirementNames.has(name),
    );
    const knownAgents = new Set(this.agentMap.keys());
    const unknownAgents = [
      ...new Set([...state.activeAgents, ...state.failedAgents]),
    ].filter((agentId) => !knownAgents.has(agentId));
    if (unknownRequirements.length > 0) {
      throw new Error(
        "unknown completed requirements: " + unknownRequirements.join(", "),
      );
    }
    if (unknownAgents.length > 0) {
      throw new Error(
        "unknown agents in execution state: " + unknownAgents.join(", "),
      );
    }
    if (state.completedRequirements.size === requirementNames.size) {
      throw new Error("task is already complete");
    }
  }

  private prepareBids(
    task: NormalizedTask,
    suppliedBids: readonly SageBid[] | undefined,
  ): Map<string, NormalizedBid> {
    const supplied = new Map<string, NormalizedBid>();
    for (const bidInput of suppliedBids ?? []) {
      if (bidInput.taskId === task.taskId) {
        supplied.set(bidInput.agentId, normalizeBid(bidInput));
      }
    }
    return new Map(
      [...this.agentMap.values()].map((agent) => [
        agent.agentId,
        supplied.get(agent.agentId) ?? {
          agentId: agent.agentId,
          taskId: task.taskId,
          quotedCost: agent.cost,
          promisedLatencyMs: agent.latencyMs,
          confidence: 0.7,
        },
      ]),
    );
  }

  private riskAdjustedCost(agentId: string, bid: NormalizedBid): number {
    return (
      bid.quotedCost *
      (1 + 0.2 * (1 - this.costFidelity.get(agentId)!.mean))
    );
  }

  private riskAdjustedLatency(agentId: string, bid: NormalizedBid): number {
    const agent = this.agentMap.get(agentId)!;
    const quote =
      bid.promisedLatencyMs *
      (1 + 0.2 * (1 - this.latencyFidelity.get(agentId)!.mean));
    return (quote * (1 + 0.5 * agent.load)) / Math.max(agent.availability, 0.1);
  }

  private eligible(
    agent: NormalizedAgent,
    task: NormalizedTask,
    bid: NormalizedBid,
  ): boolean {
    for (const permission of task.requiredPermissions) {
      if (!agent.permissions.has(permission)) {
        return false;
      }
    }
    return (
      agent.availability > 0 &&
      this.riskAdjustedCost(agent.agentId, bid) <= task.budget &&
      this.riskAdjustedLatency(agent.agentId, bid) <= task.deadlineMs
    );
  }

  private beliefValue(key: string, belief: BetaBelief): number {
    if (!this.exploration) {
      return belief.mean;
    }
    if (!this.drawCache.has(key)) {
      this.drawCache.set(key, belief.draw(this.random));
    }
    return this.drawCache.get(key)!;
  }

  private getSkillBelief(agentId: string, requirement: string): BetaBelief {
    const key = agentId + "\u0000" + requirement;
    let belief = this.skillReliability.get(key);
    if (!belief) {
      belief = new BetaBelief();
      this.skillReliability.set(key, belief);
    }
    return belief;
  }

  private getSynergyBelief(left: string, right: string): BetaBelief {
    const [first, second] = sortedPair(left, right);
    const key = first + "\u0000" + second;
    let belief = this.synergy.get(key);
    if (!belief) {
      belief = new BetaBelief();
      this.synergy.set(key, belief);
    }
    return belief;
  }

  private contextualTrust(
    agentId: string,
    requirement: string,
  ): { trust: number; uncertainty: number } {
    const globalBelief = this.reliability.get(agentId)!;
    const skillBelief = this.getSkillBelief(agentId, requirement);
    const globalValue = this.beliefValue("global:" + agentId, globalBelief);
    const skillValue = this.beliefValue(
      "skill:" + agentId + ":" + requirement,
      skillBelief,
    );
    return {
      trust: 0.35 * globalValue + 0.65 * skillValue,
      uncertainty:
        0.35 * globalBelief.uncertainty + 0.65 * skillBelief.uncertainty,
    };
  }

  private effectiveSkill(
    agentId: string,
    requirement: string,
    bid: NormalizedBid,
  ): number {
    const agent = this.agentMap.get(agentId)!;
    const declared = agent.skills[requirement] ?? 0;
    const { trust } = this.contextualTrust(agentId, requirement);
    const calibratedBid = trust * bid.confidence + (1 - trust) * 0.5;
    return declared * (0.65 + 0.35 * trust) * (0.7 + 0.3 * calibratedBid);
  }

  private remainingRequirements(
    task: NormalizedTask,
    state: NormalizedState,
  ): readonly NormalizedRequirement[] {
    return task.requirements.filter(
      (item) => !state.completedRequirements.has(item.name),
    );
  }

  private coverageAndAssignment(
    team: readonly string[],
    task: NormalizedTask,
    bids: ReadonlyMap<string, NormalizedBid>,
    state: NormalizedState,
  ): CoverageResult {
    const requirements = this.remainingRequirements(task, state);
    const totalWeight = requirements.reduce((sum, item) => sum + item.weight, 0);
    let weighted = 0;
    const bottlenecks: number[] = [];
    const assignments: Record<string, string> = {};
    let trustTotal = 0;
    let uncertaintyTotal = 0;

    for (const requirement of requirements) {
      const skills = team.map((agentId) => ({
        agentId,
        score: this.effectiveSkill(
          agentId,
          requirement.name,
          bids.get(agentId)!,
        ),
      }));
      const coverage =
        1 - skills.reduce((product, item) => product * (1 - item.score), 1);
      const best = skills.reduce((current, item) =>
        item.score > current.score ? item : current,
      );
      assignments[requirement.name] = best.agentId;
      weighted += requirement.weight * coverage;
      bottlenecks.push(
        Math.min(1, best.score / Math.max(requirement.minimum, 1e-9)),
      );
      const trust = this.contextualTrust(best.agentId, requirement.name);
      trustTotal += requirement.weight * trust.trust;
      uncertaintyTotal += requirement.weight * trust.uncertainty;
    }

    return {
      coverage: weighted / totalWeight,
      bottleneck: Math.min(...bottlenecks),
      assignments,
      trust: trustTotal / totalWeight,
      uncertainty: uncertaintyTotal / totalWeight,
    };
  }

  private cosine(
    left: string,
    right: string,
    requirements: readonly NormalizedRequirement[],
  ): number {
    const leftScores = requirements.map(
      (item) => this.agentMap.get(left)!.skills[item.name] ?? 0,
    );
    const rightScores = requirements.map(
      (item) => this.agentMap.get(right)!.skills[item.name] ?? 0,
    );
    const dot = leftScores.reduce(
      (sum, value, index) => sum + value * (rightScores[index] ?? 0),
      0,
    );
    const norm = Math.sqrt(
      leftScores.reduce((sum, value) => sum + value * value, 0) *
        rightScores.reduce((sum, value) => sum + value * value, 0),
    );
    return norm === 0 ? 0 : dot / norm;
  }

  private teamTerms(
    team: readonly string[],
    requirements: readonly NormalizedRequirement[],
  ): { synergy: number; redundancy: number } {
    const pairs: Array<[string, string]> = [];
    for (let left = 0; left < team.length; left += 1) {
      for (let right = left + 1; right < team.length; right += 1) {
        const leftAgent = team[left];
        const rightAgent = team[right];
        if (leftAgent !== undefined && rightAgent !== undefined) {
          pairs.push(sortedPair(leftAgent, rightAgent));
        }
      }
    }
    if (pairs.length === 0) {
      return { synergy: 0, redundancy: 0 };
    }
    const synergy = pairs.reduce(
      (sum, [left, right]) =>
        sum +
        (2 * this.beliefValue(
          "pair:" + left + ":" + right,
          this.getSynergyBelief(left, right),
        ) - 1),
      0,
    );
    const redundancy = pairs.reduce(
      (sum, [left, right]) => sum + this.cosine(left, right, requirements),
      0,
    );
    return {
      synergy: synergy / pairs.length,
      redundancy: redundancy / pairs.length,
    };
  }

  private topologicalRequirements(
    task: NormalizedTask,
    state: NormalizedState,
  ): NormalizedRequirement[] {
    const remaining = new Map(
      this.remainingRequirements(task, state).map((item) => [item.name, item]),
    );
    const emitted = new Set(state.completedRequirements);
    const ordered: NormalizedRequirement[] = [];
    while (remaining.size > 0) {
      const ready = [...remaining.values()]
        .filter((item) => item.dependsOn.every((dependency) => emitted.has(dependency)))
        .sort((left, right) => left.name.localeCompare(right.name));
      if (ready.length === 0) {
        throw new Error("no executable requirement remains in task DAG");
      }
      for (const item of ready) {
        ordered.push(item);
        emitted.add(item.name);
        remaining.delete(item.name);
      }
    }
    return ordered;
  }

  private schedule(
    assignments: Readonly<Record<string, string>>,
    task: NormalizedTask,
    bids: ReadonlyMap<string, NormalizedBid>,
    state: NormalizedState,
  ): { latency: number; topology: readonly (readonly [string, string])[] } {
    const requirements = this.remainingRequirements(task, state);
    const totalWeight = requirements.reduce((sum, item) => sum + item.weight, 0);
    const finish = new Map<string, number>(
      [...state.completedRequirements].map((name) => [name, 0]),
    );
    const usedAgents = [...new Set(Object.values(assignments))];
    const agentReady = new Map(usedAgents.map((agentId) => [agentId, 0]));
    const topology = new Set<string>();

    for (const item of this.topologicalRequirements(task, state)) {
      const agentId = assignments[item.name]!;
      const dependencyReady = Math.max(
        ...item.dependsOn.map((dependency) => finish.get(dependency) ?? 0),
        0,
      );
      const start = Math.max(dependencyReady, agentReady.get(agentId) ?? 0);
      const duration =
        (this.riskAdjustedLatency(agentId, bids.get(agentId)!) * item.weight) /
        totalWeight;
      finish.set(item.name, start + duration);
      agentReady.set(agentId, start + duration);
      for (const dependency of item.dependsOn) {
        const dependencyAgent = assignments[dependency];
        if (dependencyAgent && dependencyAgent !== agentId) {
          topology.add(dependencyAgent + "\u0000" + agentId);
        }
      }
    }

    const coordinator = usedAgents.includes(this.incumbentId)
      ? this.incumbentId
      : [...usedAgents].sort()[0]!;
    const connected = new Set<string>();
    for (const edge of topology) {
      const [left, right] = edge.split("\u0000");
      connected.add(left!);
      connected.add(right!);
    }
    for (const agentId of usedAgents.sort()) {
      if (agentId !== coordinator && !connected.has(agentId)) {
        topology.add(coordinator + "\u0000" + agentId);
      }
    }

    const latency =
      Math.max(...finish.values(), 0) *
      (1 + task.coordinationOverhead * topology.size);
    return {
      latency,
      topology: [...topology]
        .map((edge) => edge.split("\u0000") as [string, string])
        .sort(([leftA, rightA], [leftB, rightB]) =>
          (leftA + "\u0000" + rightA).localeCompare(
            leftB + "\u0000" + rightB,
          ),
        ),
    };
  }

  private switchLoss(
    mode: SageMode,
    team: readonly string[],
    task: NormalizedTask,
    state: NormalizedState,
  ): number {
    if (state.activeAgents.length === 0) {
      if (mode !== "handoff") {
        return 0;
      }
      const progress = state.progress ?? task.progress;
      const transferability =
        state.transferableContext ?? task.contextTransferability;
      return progress * task.handoffFriction * (1 - 0.65 * transferability);
    }
    if (mode === state.activeMode && setEquals(team, state.activeAgents)) {
      return 0;
    }
    const union = new Set([...team, ...state.activeAgents]);
    const retained =
      team.filter((agentId) => state.activeAgents.includes(agentId)).length /
      Math.max(1, union.size);
    const progress = state.progress ?? task.progress;
    const transferability =
      state.transferableContext ?? task.contextTransferability;
    const contextLoss =
      progress * (1 - transferability) * (1 - retained);
    const recoveryDiscount = 1 / (1 + state.failureCount);
    return (
      (task.replanFriction + task.handoffFriction * contextLoss) *
      recoveryDiscount
    );
  }

  private evaluate(
    mode: SageMode,
    team: readonly string[],
    task: NormalizedTask,
    bids: ReadonlyMap<string, NormalizedBid>,
    state: NormalizedState,
  ): SageDecision {
    const requirements = this.remainingRequirements(task, state);
    const coverageResult = this.coverageAndAssignment(team, task, bids, state);
    const terms = this.teamTerms(team, requirements);
    const scheduled = this.schedule(
      coverageResult.assignments,
      task,
      bids,
      state,
    );
    const cost = team.reduce(
      (sum, agentId) => sum + this.riskAdjustedCost(agentId, bids.get(agentId)!),
      0,
    );
    const coordinationLoss =
      mode === "collaborate"
        ? task.coordinationOverhead * scheduled.topology.length
        : 0;
    const switchLoss = this.switchLoss(mode, team, task, state);
    const handoffLoss = mode === "handoff" ? switchLoss : 0;
    const meanLoad =
      team.reduce((sum, agentId) => sum + this.agentMap.get(agentId)!.load, 0) /
      team.length;
    const modelFeatures: Record<string, number> = {
      coverage: coverageResult.coverage,
      bottleneck: coverageResult.bottleneck,
      trust: coverageResult.trust,
      synergy: terms.synergy,
      redundancy: terms.redundancy,
      coordination_loss: coordinationLoss,
      handoff_loss: handoffLoss,
      switch_loss: switchLoss,
      load: meanLoad,
    };
    const probability = this.successModel.predict(modelFeatures);
    const risk = 1 - coverageResult.trust;
    const normalizedCost = Number.isFinite(task.budget)
      ? cost / task.budget
      : cost / task.value;
    const normalizedLatency = Number.isFinite(task.deadlineMs)
      ? scheduled.latency / task.deadlineMs
      : scheduled.latency / 10_000;
    const explorationBonus = this.exploration
      ? this.weights.exploration * coverageResult.uncertainty
      : 0;
    const utility =
      task.value * probability -
      this.weights.cost * normalizedCost -
      this.weights.latency * normalizedLatency -
      this.weights.risk * risk * (1 - task.riskTolerance / 2) -
      this.weights.handoff * handoffLoss -
      this.weights.coordination * coordinationLoss -
      this.weights.uncertainty * coverageResult.uncertainty +
      explorationBonus;

    return {
      mode,
      agents: [...team],
      utility,
      successProbability: probability,
      coverage: coverageResult.coverage,
      cost,
      latencyMs: scheduled.latency,
      risk,
      explanation: this.explain(
        mode,
        team,
        probability,
        coverageResult.coverage,
        switchLoss,
        coverageResult.assignments,
      ),
      assignments: coverageResult.assignments,
      topology: scheduled.topology,
      switchRecommended: false,
      diagnostics: {
        bottleneck: coverageResult.bottleneck,
        synergy: terms.synergy,
        redundancy: terms.redundancy,
        handoff_loss: handoffLoss,
        coordination_loss: coordinationLoss,
        switch_loss: switchLoss,
        uncertainty: coverageResult.uncertainty,
        exploration_bonus: explorationBonus,
        model_updates: this.successModel.updates,
      },
      modelFeatures,
    };
  }

  private teamFeasible(decision: SageDecision, task: NormalizedTask): boolean {
    return decision.cost <= task.budget && decision.latencyMs <= task.deadlineMs;
  }

  private beamCollaborationDecisions(
    task: NormalizedTask,
    eligible: readonly string[],
    bids: ReadonlyMap<string, NormalizedBid>,
    state: NormalizedState,
  ): SageDecision[] {
    const pool = eligible
      .filter((agentId) => agentId !== this.incumbentId)
      .sort();
    let frontier: string[][] = [[this.incumbentId]];
    const decisions = new Map<string, SageDecision>();

    for (let depth = 0; depth < this.maxCollaborators; depth += 1) {
      const expanded = new Map<string, SageDecision>();
      for (const team of frontier) {
        for (const agentId of pool) {
          if (team.includes(agentId)) {
            continue;
          }
          const candidate = [...team, agentId];
          const quotedCost = candidate.reduce(
            (sum, item) => sum + this.riskAdjustedCost(item, bids.get(item)!),
            0,
          );
          if (quotedCost > task.budget) {
            continue;
          }
          const key = [...candidate].sort().join("\u0000");
          if (expanded.has(key)) {
            continue;
          }
          const decision = this.evaluate(
            "collaborate",
            candidate,
            task,
            bids,
            state,
          );
          expanded.set(key, decision);
          if (this.teamFeasible(decision, task)) {
            decisions.set(key, decision);
          }
        }
      }
      frontier = [...expanded.values()]
        .sort((left, right) => right.utility - left.utility)
        .slice(0, this.beamWidth)
        .map((decision) => [...decision.agents]);
      if (frontier.length === 0) {
        break;
      }
    }
    return [...decisions.values()];
  }

  private explain(
    mode: SageMode,
    team: readonly string[],
    probability: number,
    coverage: number,
    switchLoss: number,
    assignments: Readonly<Record<string, string>>,
  ): string {
    const names = team.join(", ");
    const roleSummary = Object.entries(assignments)
      .map(([requirement, agent]) => requirement + "->" + agent)
      .join(", ");
    let reason: string;
    if (mode === "self") {
      reason = "the incumbent has the highest constrained expected utility";
    } else if (mode === "handoff") {
      reason =
        "specialist gain exceeds context-transfer and switching loss (" +
        switchLoss.toFixed(3) +
        ")";
    } else {
      reason = "the selected team improves task-DAG coverage after coordination cost";
    }
    return (
      mode.toUpperCase() +
      " via [" +
      names +
      "]: " +
      reason +
      "; estimated success=" +
      probability.toFixed(3) +
      ", coverage=" +
      coverage.toFixed(3) +
      "; assignments: " +
      roleSummary +
      "."
    );
  }
}
