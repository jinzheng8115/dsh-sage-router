import Schema from "@deepseek-ai/schemastery";

import type {
  SageAgent,
  SageRouterWeights,
} from "./core/types.js";

export interface SageToolFilter {
  allow?: readonly string[];
  deny?: readonly string[];
}

export interface SageAgentConfig extends SageAgent {
  provider: string;
  subagentProvider?: string;
  model?: string;
  persona?: string;
  toolFilter?: SageToolFilter;
}

export interface SagePluginConfig {
  agents: readonly SageAgentConfig[];
  incumbentId: string;
  maxCollaborators: number;
  beamWidth: number;
  exploration: boolean;
  defaultDeadlineMs: number;
  defaultBudget: number;
  autoOrchestrate: boolean;
  maxDelegationDepth?: number;
  weights?: SageRouterWeights;
  /**
   * Append `sage/*` events to the harness session log. Defaults to false:
   * harness builds that do not know these types refuse to resume any session
   * whose log contains them unless each event is marked `ignorable`, and
   * current `SessionStore.append` offers no way to set that marker.
   */
  sessionEventLog: boolean;
}

export type SagePluginConfigInput = Omit<
  SagePluginConfig,
  | "maxCollaborators"
  | "beamWidth"
  | "exploration"
  | "defaultDeadlineMs"
  | "defaultBudget"
  | "autoOrchestrate"
> & {
  maxCollaborators?: number;
  beamWidth?: number;
  exploration?: boolean;
  defaultDeadlineMs?: number;
  defaultBudget?: number;
  autoOrchestrate?: boolean;
  maxDelegationDepth?: number;
  sessionEventLog?: boolean;
};

export type SageConfigErrorCode =
  | "SAGE_CONFIG_INVALID"
  | "SAGE_CONFIG_DUPLICATE_AGENT"
  | "SAGE_CONFIG_UNKNOWN_INCUMBENT"
  | "SAGE_CONFIG_INVALID_PERMISSION"
  | "SAGE_CONFIG_INVALID_LIMIT";

export class SageConfigError extends Error {
  public constructor(
    public readonly code: SageConfigErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "SageConfigError";
  }
}

const nonEmptyString = () => Schema.string().required();
const optionalString = () => Schema.string().required(false);
const scoreSchema = Schema.number().min(0).max(1);
const weightSchema = Schema.number().min(0);
const namePattern = /^\S+$/;

const toolFilterSchema = Schema.object({
  allow: Schema.array(nonEmptyString()).required(false),
  deny: Schema.array(nonEmptyString()).required(false),
}).required(false);

const agentConfigSchema = Schema.object({
  agentId: nonEmptyString(),
  provider: nonEmptyString(),
  subagentProvider: optionalString(),
  model: optionalString(),
  persona: optionalString(),
  skills: Schema.dict(scoreSchema).required(),
  cost: Schema.number().min(0).required(),
  latencyMs: Schema.number().min(0).required(),
  permissions: Schema.array(nonEmptyString()).required(false),
  availability: scoreSchema.required(false),
  load: scoreSchema.required(false),
  toolFilter: toolFilterSchema,
});

const rawConfigSchema = Schema.object({
  agents: Schema.array(agentConfigSchema).required(),
  incumbentId: nonEmptyString(),
  maxCollaborators: Schema.number().required(false),
  beamWidth: Schema.number().required(false),
  exploration: Schema.boolean().required(false),
  defaultDeadlineMs: Schema.number().required(false),
  defaultBudget: Schema.number().required(false),
  autoOrchestrate: Schema.boolean().required(false),
  maxDelegationDepth: Schema.number().required(false),
  sessionEventLog: Schema.boolean().required(false),
  weights: Schema.object({
    cost: weightSchema.required(false),
    latency: weightSchema.required(false),
    risk: weightSchema.required(false),
    handoff: weightSchema.required(false),
    coordination: weightSchema.required(false),
    uncertainty: weightSchema.required(false),
    exploration: weightSchema.required(false),
  }).required(false),
});

function fail(code: SageConfigErrorCode, message: string): never {
  throw new SageConfigError(code, message);
}

function requireName(value: string, label: string): string {
  if (!value || !namePattern.test(value)) {
    fail("SAGE_CONFIG_INVALID", `${label} must be a non-empty token`);
  }
  return value;
}

function normalizeNameList(
  values: readonly string[] | ReadonlySet<string> | undefined,
  label: string,
): readonly string[] {
  const result = [...(values ?? [])];
  const seen = new Set<string>();
  for (const value of result) {
    if (!value || !namePattern.test(value)) {
      fail("SAGE_CONFIG_INVALID_PERMISSION", `${label} contains an invalid name`);
    }
    if (seen.has(value)) {
      fail("SAGE_CONFIG_INVALID_PERMISSION", `${label} contains duplicate "${value}"`);
    }
    seen.add(value);
  }
  return result;
}

function normalizeAgent(input: SageAgentConfig): SageAgentConfig {
  requireName(input.agentId, "agent_id");
  requireName(input.provider, "provider");

  const skills = { ...input.skills };
  for (const [skill, score] of Object.entries(skills)) {
    if (!skill || !namePattern.test(skill)) {
      fail("SAGE_CONFIG_INVALID", "skills contains an empty or invalid skill name");
    }
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      fail("SAGE_CONFIG_INVALID", `skill "${skill}" must be in [0, 1]`);
    }
  }

  const permissions = normalizeNameList(input.permissions, "permissions");
  const allow = normalizeNameList(input.toolFilter?.allow, "toolFilter.allow");
  const deny = normalizeNameList(input.toolFilter?.deny, "toolFilter.deny");
  const denied = new Set(deny);
  if (allow.some((name) => denied.has(name))) {
    fail(
      "SAGE_CONFIG_INVALID_PERMISSION",
      "toolFilter.allow and toolFilter.deny must not overlap",
    );
  }

  return {
    agentId: input.agentId,
    provider: input.provider,
    ...(input.subagentProvider === undefined
      ? {}
      : { subagentProvider: requireName(input.subagentProvider, "subagentProvider") }),
    ...(input.model === undefined ? {} : { model: requireName(input.model, "model") }),
    ...(input.persona === undefined ? {} : { persona: input.persona }),
    skills,
    cost: input.cost,
    latencyMs: input.latencyMs,
    permissions,
    availability: input.availability ?? 1,
    load: input.load ?? 0,
    ...(allow.length > 0 || deny.length > 0
      ? { toolFilter: { allow, deny } }
      : {}),
  };
}

function validateLimits(
  value: number,
  label: string,
  predicate: (candidate: number) => boolean,
): number {
  if (!Number.isFinite(value) || !predicate(value)) {
    fail("SAGE_CONFIG_INVALID_LIMIT", `${label} is invalid`);
  }
  return value;
}

export function parseSagePluginConfig(value: unknown): SagePluginConfig {
  const raw = (rawConfigSchema as unknown as (input: unknown) => SagePluginConfigInput)(
    value,
  );
  const agents = raw.agents.map(normalizeAgent);
  if (agents.length === 0) {
    fail("SAGE_CONFIG_INVALID", "agents must not be empty");
  }

  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.agentId)) {
      fail("SAGE_CONFIG_DUPLICATE_AGENT", `duplicate agent_id: ${agent.agentId}`);
    }
    ids.add(agent.agentId);
  }
  if (!ids.has(raw.incumbentId)) {
    fail(
      "SAGE_CONFIG_UNKNOWN_INCUMBENT",
      `incumbent_id must identify a registered agent: ${raw.incumbentId}`,
    );
  }

  const maxCollaborators = validateLimits(
    raw.maxCollaborators ?? Math.min(2, agents.length),
    "max_collaborators",
    (candidate) =>
      Number.isInteger(candidate) && candidate >= 0 && candidate <= agents.length,
  );
  const beamWidth = validateLimits(
    raw.beamWidth ?? 8,
    "beam_width",
    (candidate) => Number.isInteger(candidate) && candidate >= 1 && candidate <= 64,
  );
  const defaultDeadlineMs = validateLimits(
    raw.defaultDeadlineMs ?? 120_000,
    "default_deadline_ms",
    (candidate) => candidate > 0,
  );
  const defaultBudget = validateLimits(
    raw.defaultBudget ?? 10,
    "default_budget",
    (candidate) => candidate > 0,
  );
  const maxDelegationDepth = validateLimits(
    raw.maxDelegationDepth ?? 1,
    "max_delegation_depth",
    (candidate) => Number.isInteger(candidate) && candidate >= 0 && candidate <= 32,
  );

  return {
    agents,
    incumbentId: raw.incumbentId,
    maxCollaborators,
    beamWidth,
    exploration: raw.exploration ?? false,
    defaultDeadlineMs,
    defaultBudget,
    autoOrchestrate: raw.autoOrchestrate ?? false,
    maxDelegationDepth,
    sessionEventLog: raw.sessionEventLog ?? false,
    ...(raw.weights === undefined ? {} : { weights: { ...raw.weights } }),
  };
}

export const sagePluginConfigSchema = Schema.transform(
  rawConfigSchema,
  (value) => parseSagePluginConfig(value),
) as unknown as Schema<unknown, SagePluginConfig>;

export const Config = sagePluginConfigSchema;
