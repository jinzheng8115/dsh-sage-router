export type SageMode = "self" | "collaborate" | "handoff";

export interface SageRequirement {
  name: string;
  weight?: number;
  minimum?: number;
  dependsOn?: readonly string[];
}

export interface SageTask {
  taskId: string;
  requirements: readonly SageRequirement[];
  value?: number;
  budget?: number;
  deadlineMs?: number;
  requiredPermissions?: readonly string[] | ReadonlySet<string>;
  riskTolerance?: number;
  progress?: number;
  handoffFriction?: number;
  coordinationOverhead?: number;
  contextTransferability?: number;
  replanFriction?: number;
}

export interface SageAgent {
  agentId: string;
  skills: Readonly<Record<string, number>>;
  cost: number;
  latencyMs: number;
  permissions?: readonly string[] | ReadonlySet<string>;
  availability?: number;
  load?: number;
}

export interface SageBid {
  agentId: string;
  taskId: string;
  quotedCost: number;
  promisedLatencyMs: number;
  confidence?: number;
}

export interface SageExecutionState {
  activeAgents?: readonly string[];
  activeMode?: SageMode;
  completedRequirements?: ReadonlySet<string> | readonly string[];
  progress?: number | null;
  transferableContext?: number | null;
  failedAgents?: ReadonlySet<string> | readonly string[];
  failureCount?: number;
}

export interface SageRouterWeights {
  cost?: number;
  latency?: number;
  risk?: number;
  handoff?: number;
  coordination?: number;
  uncertainty?: number;
  exploration?: number;
}

export interface SageRouterOptions {
  weights?: SageRouterWeights;
  maxCollaborators?: number;
  beamWidth?: number;
  exploration?: boolean;
  seed?: number;
}

export interface SageDecision {
  mode: SageMode;
  agents: readonly string[];
  utility: number;
  successProbability: number;
  coverage: number;
  cost: number;
  latencyMs: number;
  risk: number;
  explanation: string;
  assignments: Readonly<Record<string, string>>;
  topology: readonly (readonly [string, string])[];
  switchRecommended: boolean;
  diagnostics: Readonly<Record<string, number>>;
  modelFeatures: Readonly<Record<string, number>>;
}

export interface SageOutcome {
  success: number | boolean;
  agentScores?: Readonly<Record<string, number>>;
  requirementScores?: Readonly<Record<string, number>>;
  actualCost?: number | null;
  actualLatencyMs?: number | null;
}

export interface BetaBeliefSnapshot {
  alpha: number;
  beta: number;
}

export interface OnlineSuccessModelSnapshot {
  learningRate: number;
  l2: number;
  updates: number;
  bias: number;
  weights: Readonly<Record<string, number>>;
}

export interface SageRouterLearningSnapshot {
  reliability: Readonly<Record<string, BetaBeliefSnapshot>>;
  skillReliability: Readonly<Record<string, BetaBeliefSnapshot>>;
  synergy: Readonly<Record<string, BetaBeliefSnapshot>>;
  costFidelity: Readonly<Record<string, BetaBeliefSnapshot>>;
  latencyFidelity: Readonly<Record<string, BetaBeliefSnapshot>>;
  successModel: OnlineSuccessModelSnapshot;
}
