export interface SageContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface SageObjectJsonSchema {
  type: "object";
  properties: Readonly<Record<string, unknown>>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface SageToolRestriction {
  allow?: readonly string[];
  deny?: readonly string[];
}

export interface HarnessAgentRef {
  sessionId: string;
  provider: string;
  model?: string;
  /** Native Agent object, present only inside a live Harness agent scope. */
  agent?: unknown;
}

export interface SageRequirementResult {
  requirement: string;
  score: number;
  summary?: string;
  artifacts?: readonly string[];
  agentId?: string;
}

export interface SageSubagentResult {
  status: "completed" | "failed" | "aborted";
  requirementResults: readonly SageRequirementResult[];
  actualCost?: number;
  actualLatencyMs?: number;
  diagnostic?: string;
}

export interface SageSubagentRun {
  id: string;
  result: Promise<SageSubagentResult>;
  dispose(): Promise<void>;
}

export interface SageSubagentStartInput {
  requirement: string;
  agentId: string;
  provider: string;
  subagentProvider?: string;
  model?: string;
  parent: HarnessAgentRef;
  prompt: readonly SageContentBlock[];
  outputSchema: SageObjectJsonSchema;
  toolFilter?: SageToolRestriction;
  persona?: string;
  maxDepth?: number;
  signal: AbortSignal;
}

export interface SageSubagentGateway {
  start(input: SageSubagentStartInput): Promise<SageSubagentRun>;
  interrupt(runId: string, signal: AbortSignal): Promise<void>;
}

interface NativeSubagentRun {
  id: string;
  result: Promise<NativeSubagentResult>;
  dispose(): Promise<void>;
}

interface NativeSubagentResult {
  structured?: unknown;
  stopReason: string;
  diagnostic?: string;
}

interface NativeSubagentRuntime {
  start(
    provider: string,
    request: {
      label?: string;
      prompt: readonly SageContentBlock[];
      parent: unknown;
      signal: AbortSignal;
      agentOptions?: { provider?: string; model?: string };
      outputSchema?: SageObjectJsonSchema;
      maxDepth?: number;
      toolFilter?: SageToolRestriction;
      persona?: string;
    },
  ): Promise<NativeSubagentRun>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    subagents: NativeSubagentRuntime;
  }
}

export class SageSubagentError extends Error {
  public constructor(
    public readonly code:
      | "SAGE_SUBAGENT_PARENT_REQUIRED"
      | "SAGE_UNSUPPORTED_CAPABILITY",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options);
    this.name = "SageSubagentError";
  }
}

export class ContextSubagentGateway implements SageSubagentGateway {
  private readonly runs = new Map<string, () => Promise<void>>();

  public constructor(private readonly runtime: NativeSubagentRuntime) {}

  public async start(input: SageSubagentStartInput): Promise<SageSubagentRun> {
    if (input.parent.agent === undefined) {
      throw new SageSubagentError(
        "SAGE_SUBAGENT_PARENT_REQUIRED",
        "ctx.subagents requires a live parent Agent",
      );
    }

    let nativeRun: NativeSubagentRun;
    try {
      nativeRun = await this.runtime.start(
        input.subagentProvider ?? input.provider,
        {
          label: `sage:${input.agentId}:${input.requirement}`,
          prompt: input.prompt,
          parent: input.parent.agent,
          signal: input.signal,
          agentOptions: {
            provider: input.provider,
            ...(input.model === undefined ? {} : { model: input.model }),
          },
          outputSchema: input.outputSchema,
          ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          ...(input.toolFilter === undefined ? {} : { toolFilter: input.toolFilter }),
          ...(input.persona === undefined ? {} : { persona: input.persona }),
        },
      );
    } catch (error) {
      if (isUnsupportedCapability(error)) {
        throw new SageSubagentError(
          "SAGE_UNSUPPORTED_CAPABILITY",
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
      throw error;
    }
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      try {
        await nativeRun.dispose();
      } finally {
        this.runs.delete(nativeRun.id);
      }
    };
    this.runs.set(nativeRun.id, dispose);

    return {
      id: nativeRun.id,
      result: nativeRun.result.then((result) => normalizeResult(result, input)),
      dispose,
    };
  }

  public async interrupt(runId: string, _signal: AbortSignal): Promise<void> {
    await this.runs.get(runId)?.();
  }
}

function normalizeResult(
  result: NativeSubagentResult,
  input: SageSubagentStartInput,
): SageSubagentResult {
  const requirementResults = readRequirementResults(result.structured, input);
  if (result.stopReason === "aborted") {
    return {
      status: "aborted",
      requirementResults,
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    };
  }
  if (result.stopReason !== "completed" || requirementResults.length === 0) {
    return {
      status: "failed",
      requirementResults,
      diagnostic:
        result.diagnostic ??
        `subagent stopped with ${result.stopReason} without structured requirement results`,
    };
  }
  return {
    status: "completed",
    requirementResults,
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
  };
}

function readRequirementResults(
  structured: unknown,
  input: SageSubagentStartInput,
): readonly SageRequirementResult[] {
  if (!isRecord(structured) || !Array.isArray(structured.requirementResults)) {
    return [];
  }
  const results: SageRequirementResult[] = [];
  for (const item of structured.requirementResults) {
    if (!isRecord(item) || typeof item.requirement !== "string") continue;
    const score = typeof item.score === "number" ? item.score : Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > 1) continue;
    results.push({
      requirement: item.requirement,
      score,
      agentId: input.agentId,
      ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
      ...(Array.isArray(item.artifacts) &&
      item.artifacts.every((artifact): artifact is string => typeof artifact === "string")
        ? { artifacts: item.artifacts }
        : {}),
    });
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsupportedCapability(error: unknown): boolean {
  if (isRecord(error) && error.code === "UNSUPPORTED_CAPABILITY") return true;
  return /unsupported.*capabilit/i.test(error instanceof Error ? error.message : String(error));
}
