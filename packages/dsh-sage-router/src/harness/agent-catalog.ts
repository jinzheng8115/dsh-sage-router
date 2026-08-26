import type { SageAgent } from "../core/types.js";
import type { SageAgentConfig, SagePluginConfig } from "../config.js";

export class AgentCatalog {
  private readonly entries: readonly SageAgentConfig[];

  public constructor(agents: readonly SageAgentConfig[]) {
    this.entries = agents.map((agent) => ({
      ...agent,
      skills: { ...agent.skills },
      permissions: [...(agent.permissions ?? [])],
      ...(agent.toolFilter === undefined
        ? {}
        : {
            toolFilter: {
              ...(agent.toolFilter.allow === undefined
                ? {}
                : { allow: [...agent.toolFilter.allow] }),
              ...(agent.toolFilter.deny === undefined
                ? {}
                : { deny: [...agent.toolFilter.deny] }),
            },
          }),
    }));
  }

  public ids(): readonly string[] {
    return this.entries.map((agent) => agent.agentId);
  }

  public get(agentId: string): SageAgentConfig | undefined {
    return this.entries.find((agent) => agent.agentId === agentId);
  }

  public list(): readonly SageAgentConfig[] {
    return this.entries;
  }

  public coreAgents(): readonly SageAgent[] {
    return this.entries.map(({ provider: _provider, subagentProvider: _subagentProvider, model: _model, persona: _persona, toolFilter: _toolFilter, ...agent }) => ({
      ...agent,
      skills: { ...agent.skills },
      permissions: [...(agent.permissions ?? [])],
    }));
  }
}

export function createAgentCatalog(config: SagePluginConfig): AgentCatalog {
  return new AgentCatalog(config.agents);
}
