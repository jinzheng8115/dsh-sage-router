import { deepStrictEqual, equal, match, throws } from "node:assert/strict";
import test from "node:test";

import {
  parseSagePluginConfig,
  sagePluginConfigSchema,
  type SagePluginConfig,
} from "../src/config.js";
import { AgentCatalog, createAgentCatalog } from "../src/harness/agent-catalog.js";

const baseConfig = {
  agents: [
    {
      agentId: "self",
      provider: "local",
      skills: { general: 0.8 },
      cost: 1,
      latencyMs: 100,
      permissions: ["task.execute"],
    },
    {
      agentId: "researcher",
      provider: "remote",
      model: "research-model",
      skills: { research: 0.95 },
      cost: 2,
      latencyMs: 150,
      permissions: ["task.execute", "network.read"],
    },
  ],
  incumbentId: "self",
} satisfies Pick<SagePluginConfig, "agents" | "incumbentId">;

function config(overrides: Record<string, unknown> = {}): SagePluginConfig {
  return parseSagePluginConfig({ ...baseConfig, ...overrides });
}

test("normalizes valid plugin config with safe defaults", () => {
  const resolved = config();

  equal(resolved.maxCollaborators, 2);
  equal(resolved.beamWidth, 8);
  equal(resolved.exploration, false);
  equal(resolved.defaultDeadlineMs, 120_000);
  equal(resolved.defaultBudget, 10);
  equal(resolved.autoOrchestrate, false);
  equal(resolved.maxDelegationDepth, 1);
  deepStrictEqual(resolved.agents[0]?.permissions, ["task.execute"]);
});

test("exposes only declared agents and keeps Harness metadata at the catalog boundary", () => {
  const catalog = createAgentCatalog(config());

  equal(catalog instanceof AgentCatalog, true);
  deepStrictEqual(catalog.ids(), ["self", "researcher"]);
  equal(catalog.get("researcher")?.model, "research-model");
  deepStrictEqual(
    catalog.coreAgents().map((agent) => agent.agentId),
    ["self", "researcher"],
  );
});

test("rejects duplicate agents, unknown incumbent, invalid permissions, and invalid limits", () => {
  throws(
    () =>
      config({
        agents: [...baseConfig.agents, baseConfig.agents[0]],
      }),
    /duplicate agent_id/,
  );
  throws(() => config({ incumbentId: "missing" }), /incumbent_id/);
  throws(
    () =>
      config({
        agents: [
          {
            ...baseConfig.agents[0],
            permissions: ["network read"],
          },
        ],
      }),
    /permission/,
  );
  throws(() => config({ maxCollaborators: 3 }), /max_collaborators/);
  throws(() => config({ defaultBudget: -1 }), /default_budget/);
  throws(() => config({ defaultDeadlineMs: 0 }), /default_deadline_ms/);
  throws(() => config({ maxDelegationDepth: -1 }), /max_delegation_depth/);
  throws(() => config({ maxDelegationDepth: 33 }), /max_delegation_depth/);
});

test("exposes the Schemastery schema as the plugin validation seam", () => {
  const resolved = sagePluginConfigSchema({ ...baseConfig } as unknown);
  equal(resolved.incumbentId, "self");
  match(sagePluginConfigSchema.toString(), /agents/);
});
