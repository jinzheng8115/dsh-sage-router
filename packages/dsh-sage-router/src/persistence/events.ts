import type {
  SageDecision,
  SageExecutionState,
  SageOutcome,
  SageRouterLearningSnapshot,
} from "../core/types.js";

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "sage/route": SageRouteEvent;
    "sage/execution": SageExecutionEvent;
    "sage/outcome": SageOutcomeEvent;
    "sage/model-update": SageModelUpdateEvent;
  }
}

export interface SageRouteEvent {
  routeId: string;
  taskId: string;
  decision: SageDecision;
  activeState?: SageExecutionState;
}

export type SageExecutionStatus = "started" | "completed" | "failed" | "aborted";

export interface SageExecutionEvent {
  routeId: string;
  requirement: string;
  agentId: string;
  status: SageExecutionStatus;
  score?: number;
  actualCost?: number;
  actualLatencyMs?: number;
  errorCode?: string;
}

export interface SageOutcomeEvent {
  routeId: string;
  outcome: SageOutcome;
}

export interface SageLearningState extends SageRouterLearningSnapshot {
  revision: number;
}

export interface SageModelUpdateEvent {
  routeId: string;
  state: SageLearningState;
}

export interface SageEventDataMap {
  "sage/route": SageRouteEvent;
  "sage/execution": SageExecutionEvent;
  "sage/outcome": SageOutcomeEvent;
  "sage/model-update": SageModelUpdateEvent;
}

export type SageEventType = keyof SageEventDataMap;

export type SageStoredEvent = {
  [T in SageEventType]: {
    type: T;
    data: SageEventDataMap[T];
  };
}[SageEventType];

export interface SageEventAppender {
  append(event: SageStoredEvent): void;
  flush?(): Promise<void>;
}

export interface SageSessionLike {
  append(type: string, data: unknown): unknown;
}

export function createSageSessionEventAppender(
  session: SageSessionLike,
  flush?: () => Promise<void>,
): SageEventAppender {
  return {
    append(event) {
      session.append(event.type, event.data);
    },
    ...(flush === undefined ? {} : { flush }),
  };
}

export function appendSageEvent<T extends SageEventType>(
  appender: SageEventAppender,
  type: T,
  data: SageEventDataMap[T],
): void {
  appender.append(normalizeSageEvent(type, data));
}

export function parseSageStoredEvent(value: unknown): SageStoredEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("SAGE event must contain a type and data");
  }
  return normalizeSageEvent(value.type, value.data);
}

export function normalizeSageEvent(
  type: string,
  data: unknown,
): SageStoredEvent {
  switch (type) {
    case "sage/route":
      return { type, data: normalizeRouteEvent(data) };
    case "sage/execution":
      return { type, data: normalizeExecutionEvent(data) };
    case "sage/outcome":
      return { type, data: normalizeOutcomeEvent(data) };
    case "sage/model-update":
      return { type, data: normalizeModelUpdateEvent(data) };
    default:
      throw new Error(`unknown SAGE event type: ${type}`);
  }
}

export function validateLearningState(value: unknown): SageLearningState {
  if (!isRecord(value)) {
    throw new Error("learning state must be an object");
  }
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) {
    throw new Error("learning state revision must be a non-negative integer");
  }
  const state = {
    revision: Number(value.revision),
    reliability: normalizeBeliefMap(value.reliability, "reliability"),
    skillReliability: normalizeBeliefMap(
      value.skillReliability,
      "skillReliability",
    ),
    synergy: normalizeBeliefMap(value.synergy, "synergy"),
    costFidelity: normalizeBeliefMap(value.costFidelity, "costFidelity"),
    latencyFidelity: normalizeBeliefMap(
      value.latencyFidelity,
      "latencyFidelity",
    ),
    successModel: normalizeModelSnapshot(value.successModel),
  } satisfies SageLearningState;
  return cloneJson(state) as SageLearningState;
}

function normalizeRouteEvent(value: unknown): SageRouteEvent {
  if (!isRecord(value)) throw new Error("sage/route data must be an object");
  const routeId = requiredToken(value.routeId, "routeId");
  const taskId = requiredToken(value.taskId, "taskId");
  const normalized: SageRouteEvent = {
    routeId,
    taskId,
    decision: normalizeDecision(value.decision),
  };
  if (value.activeState !== undefined) {
    normalized.activeState = normalizeExecutionState(value.activeState);
  }
  return cloneJson(normalized) as SageRouteEvent;
}

function normalizeExecutionEvent(value: unknown): SageExecutionEvent {
  if (!isRecord(value)) {
    throw new Error("sage/execution data must be an object");
  }
  const status = value.status;
  if (
    status !== "started" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "aborted"
  ) {
    throw new Error("sage/execution status is invalid");
  }
  const normalized: SageExecutionEvent = {
    routeId: requiredToken(value.routeId, "routeId"),
    requirement: requiredToken(value.requirement, "requirement"),
    agentId: requiredToken(value.agentId, "agentId"),
    status,
  };
  if (value.score !== undefined) normalized.score = unitScore(value.score, "score");
  if (value.actualCost !== undefined) {
    normalized.actualCost = nonNegative(value.actualCost, "actualCost");
  }
  if (value.actualLatencyMs !== undefined) {
    normalized.actualLatencyMs = nonNegative(
      value.actualLatencyMs,
      "actualLatencyMs",
    );
  }
  if (value.errorCode !== undefined) {
    normalized.errorCode = requiredToken(value.errorCode, "errorCode");
  }
  return cloneJson(normalized) as SageExecutionEvent;
}

function normalizeOutcomeEvent(value: unknown): SageOutcomeEvent {
  if (!isRecord(value)) throw new Error("sage/outcome data must be an object");
  if (!isRecord(value.outcome)) throw new Error("outcome is required");
  const outcome = value.outcome;
  const normalized: SageOutcomeEvent = {
    routeId: requiredToken(value.routeId, "routeId"),
    outcome: {
      success: outcomeScore(outcome.success, "success"),
    },
  };
  if (outcome.agentScores !== undefined) {
    normalized.outcome.agentScores = normalizeScoreMap(
      outcome.agentScores,
      "agentScores",
    );
  }
  if (outcome.requirementScores !== undefined) {
    normalized.outcome.requirementScores = normalizeScoreMap(
      outcome.requirementScores,
      "requirementScores",
    );
  }
  if (outcome.actualCost !== undefined) {
    normalized.outcome.actualCost = nonNegative(outcome.actualCost, "actualCost");
  }
  if (outcome.actualLatencyMs !== undefined) {
    normalized.outcome.actualLatencyMs = nonNegative(
      outcome.actualLatencyMs,
      "actualLatencyMs",
    );
  }
  return cloneJson(normalized) as SageOutcomeEvent;
}

function normalizeModelUpdateEvent(value: unknown): SageModelUpdateEvent {
  if (!isRecord(value)) {
    throw new Error("sage/model-update data must be an object");
  }
  return cloneJson({
    routeId: requiredToken(value.routeId, "routeId"),
    state: validateLearningState(value.state),
  }) as SageModelUpdateEvent;
}

function normalizeDecision(value: unknown): SageDecision {
  if (!isRecord(value)) throw new Error("decision is required");
  if (
    value.mode !== "self" &&
    value.mode !== "collaborate" &&
    value.mode !== "handoff"
  ) {
    throw new Error("decision mode is invalid");
  }
  const agents = stringList(value.agents, "agents");
  if (agents.length === 0) throw new Error("decision agents must not be empty");
  const topology = value.topology;
  if (!Array.isArray(topology)) throw new Error("decision topology is required");
  const normalizedTopology = topology.map((edge, index) => {
    if (!Array.isArray(edge) || edge.length !== 2) {
      throw new Error(`topology[${index}] must contain two agents`);
    }
    return [
      requiredToken(edge[0], `topology[${index}][0]`),
      requiredToken(edge[1], `topology[${index}][1]`),
    ] as [string, string];
  });
  if (!isRecord(value.assignments)) {
    throw new Error("decision assignments are required");
  }
  const assignments: Record<string, string> = {};
  for (const [requirement, agentId] of Object.entries(value.assignments)) {
    assignments[requiredToken(requirement, "assignment requirement")] =
      requiredToken(agentId, `assignment ${requirement}`);
  }
  const normalized: SageDecision = {
    mode: value.mode,
    agents,
    utility: finiteNumber(value.utility, "utility"),
    successProbability: unitScore(value.successProbability, "successProbability"),
    coverage: unitScore(value.coverage, "coverage"),
    cost: nonNegative(value.cost, "cost"),
    latencyMs: nonNegative(value.latencyMs, "latencyMs"),
    risk: unitScore(value.risk, "risk"),
    explanation: requiredString(value.explanation, "explanation"),
    assignments,
    topology: normalizedTopology,
    switchRecommended: requiredBoolean(value.switchRecommended, "switchRecommended"),
    diagnostics: normalizeNumberMap(value.diagnostics, "diagnostics"),
    modelFeatures: normalizeNumberMap(value.modelFeatures, "modelFeatures"),
  };
  return cloneJson(normalized) as SageDecision;
}

function normalizeExecutionState(value: unknown): SageExecutionState {
  if (!isRecord(value)) throw new Error("activeState must be an object");
  const normalized: SageExecutionState = {};
  if (value.activeAgents !== undefined) {
    normalized.activeAgents = stringList(value.activeAgents, "activeAgents");
  }
  if (value.activeMode !== undefined) {
    if (
      value.activeMode !== "self" &&
      value.activeMode !== "collaborate" &&
      value.activeMode !== "handoff"
    ) {
      throw new Error("activeMode is invalid");
    }
    normalized.activeMode = value.activeMode;
  }
  if (value.completedRequirements !== undefined) {
    normalized.completedRequirements = stringList(
      value.completedRequirements,
      "completedRequirements",
    );
  }
  if (value.progress !== undefined && value.progress !== null) {
    normalized.progress = unitScore(value.progress, "progress");
  } else if (value.progress === null) {
    normalized.progress = null;
  }
  if (value.transferableContext !== undefined && value.transferableContext !== null) {
    normalized.transferableContext = unitScore(
      value.transferableContext,
      "transferableContext",
    );
  } else if (value.transferableContext === null) {
    normalized.transferableContext = null;
  }
  if (value.failedAgents !== undefined) {
    normalized.failedAgents = stringList(value.failedAgents, "failedAgents");
  }
  if (value.failureCount !== undefined) {
    if (!Number.isInteger(value.failureCount) || Number(value.failureCount) < 0) {
      throw new Error("failureCount must be a non-negative integer");
    }
    normalized.failureCount = Number(value.failureCount);
  }
  return cloneJson(normalized) as SageExecutionState;
}

function normalizeBeliefMap(
  value: unknown,
  label: string,
): Record<string, { alpha: number; beta: number }> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, { alpha: number; beta: number }> = {};
  for (const [key, snapshot] of Object.entries(value)) {
    if (!key || !isRecord(snapshot)) {
      throw new Error(`${label} contains an invalid belief`);
    }
    const alpha = positiveFinite(snapshot.alpha, `${label}.${key}.alpha`);
    const beta = positiveFinite(snapshot.beta, `${label}.${key}.beta`);
    result[key] = { alpha, beta };
  }
  return result;
}

function normalizeModelSnapshot(value: unknown): SageRouterLearningSnapshot["successModel"] {
  if (!isRecord(value)) throw new Error("successModel must be an object");
  return {
    learningRate: positiveFinite(value.learningRate, "learningRate"),
    l2: nonNegative(value.l2, "l2"),
    updates: nonNegativeInteger(value.updates, "updates"),
    bias: finiteNumber(value.bias, "bias"),
    weights: normalizeNumberMap(value.weights, "weights"),
  };
}

function normalizeScoreMap(
  value: unknown,
  label: string,
): Record<string, number> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, number> = {};
  for (const [key, score] of Object.entries(value)) {
    result[requiredToken(key, label)] = unitScore(score, `${label}.${key}`);
  }
  return result;
}

function normalizeNumberMap(
  value: unknown,
  label: string,
): Record<string, number> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, number> = {};
  for (const [key, numberValue] of Object.entries(value)) {
    result[requiredToken(key, label)] = finiteNumber(numberValue, `${label}.${key}`);
  }
  return result;
}

function stringList(value: unknown, label: string): string[] {
  const values = value instanceof Set ? [...value] : value;
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return values.map((item, index) => requiredToken(item, `${label}[${index}]`));
}

function outcomeScore(value: unknown, label: string): number | boolean {
  if (typeof value === "boolean") return value;
  return unitScore(value, label);
}

function requiredToken(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^\S+$/.test(result)) throw new Error(`${label} must be a non-empty token`);
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function positiveFinite(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function nonNegative(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function unitScore(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0 || result > 1) throw new Error(`${label} must be in [0, 1]`);
  return result;
}

function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("SAGE event data must be JSON-serializable");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      result[key] = cloneJson(item);
    }
    return result;
  }
  throw new Error("SAGE event data must be JSON-serializable");
}
