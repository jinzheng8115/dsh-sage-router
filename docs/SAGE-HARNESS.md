# SAGE in DeepSeek Harness

This document describes the installable TypeScript plugin in
`packages/dsh-sage-router`. The Python implementation remains the algorithm
reference; the plugin is the Harness execution adapter.

## Compatibility baseline

The fixed smoke baseline used by this repository is:

```text
@deepseek-ai/dsh 0.1.1-rc.2
Node.js 22+
pnpm 10+
```

The plugin does not store provider credentials. The selected Harness profile
must already own its provider, model, approval, sandbox, and credential
configuration.

## Install a local bundle

Build the package and add it to a profile:

```sh
pnpm --dir packages/dsh-sage-router install --frozen-lockfile
pnpm --dir packages/dsh-sage-router build
dsh plugin --profile sage-demo add ./packages/dsh-sage-router
dsh --profile sage-demo --dump-config
dsh --profile sage-demo
```

`dsh plugin add` installs the package into the selected profile. Because the
package declares `dsh.bundle.patch`, Harness adds its `sage-router` row to the
profile layer. The package must be built before installation so its ESM entry
exists under `dist/src/index.js`.

The bundle ships safe route-only defaults:

```yaml
maxCollaborators: 2
beamWidth: 8
exploration: false
autoOrchestrate: false
maxDelegationDepth: 1
defaultBudget: 0.3
defaultDeadlineMs: 4000
```

Replace the declared Agent metadata with the provider/model configuration of
the profile. To enable child execution, add a profile-level patch for the
`sage-router` row with `autoOrchestrate: true` and restate the complete config
object; Harness id-targeted user patches replace that row's config.

## Tool contracts

`sage_route_task` only filters declared Agents and returns a decision:

```json
{
  "task": {
    "taskId": "release-plan",
    "requirements": [
      { "name": "research" },
      { "name": "review", "dependsOn": ["research"] }
    ],
    "requiredPermissions": ["network.read"]
  }
}
```

The result contains a route ID, mode (`self`, `handoff`, or `collaborate`),
selected Agent IDs, requirement assignments, topology, cost, latency, and
diagnostics. It does not start a child Agent or execute a tool.

`sage_orchestrate_task` uses the same route seam. With the default
`autoOrchestrate: false`, it returns `planned`. With the option explicitly
enabled, the service passes each assigned requirement to `ctx.subagents`,
keeps one child per Agent active at a time, propagates cancellation, records
lifecycle events, and invokes SAGE replanning after a failed child.

Harness remains the authority for subagent lifecycle, tool scopes, approval,
sandbox, and credentials. SAGE cannot grant a permission that is absent from
the declared Agent or the parent Harness policy.

## Persistence and recovery

SAGE can append four log-only session events:

- `sage/route` — route ID, task ID, decision, and optional execution state;
- `sage/execution` — requirement, declared Agent, lifecycle status, metrics,
  and stable error code;
- `sage/outcome` — bounded scores and realized cost/latency;
- `sage/model-update` — numeric learning snapshot and monotonic revision.

These appends are gated behind the `sessionEventLog` plugin option and default
to **off**. Harness builds that do not list `sage/*` in their known event
vocabulary refuse to resume any session whose log contains them unless each
event carries the `ignorable` envelope marker, and current harness releases
provide no supported way to set that marker from a plugin
(`SessionStore.append` drops unknown options). Writing unmarked custom events
therefore bricks resume with `SessionFormatUnsupportedError`. Enable
`sessionEventLog: true` only when the target harness either knows these event
types natively or supports ignorable/registered custom events. Sessions whose
logs were written before this change must be repaired by adding
`"ignorable": true` to every `sage/*` line (seq order must be preserved).

The event schema is allow-listed and JSON-safe. It does not persist prompts,
credentials, files, raw tool arguments, or child transcripts. On startup the
plugin folds any live session events (including historical logs) and loads the
latest `sage_router_learning` storage-domain record. Learning writes use a
revision compare-and-set; a stale process is rejected. Learning state itself is
persisted through the storage domain regardless of `sessionEventLog`, so route
learning keeps working while session-log persistence stays off. If event or
storage persistence is uncertain, the execution result reports
`persistenceUncertain: true`.

## Security defaults and limits

- unknown Agents and unknown permissions fail closed;
- `toolFilter.allow` and `toolFilter.deny` are configuration-only and cannot be
  expanded by a task;
- budget, deadline, collaborator count, and DAG validity are checked before
  execution;
- execution revalidates selected Agents, assignments, permissions, budget, and
  deadline after session recovery;
- cancellation interrupts and disposes unfinished children;
- `autoOrchestrate` is disabled unless a profile explicitly enables it;
- the plugin does not replace Harness approval, sandbox, identity, or secret
  management.

This first integration does not implement signed Agent Cards, remote A2A
discovery, or network transport. Production deployments must review the full
Harness profile and external Agent identity before enabling child execution.

## Fixed Harness smoke test

The opt-in smoke command verifies the Harness version, installs the local
bundle into the selected profile, checks the composed config, and asks the
real model to call `sage_route_task` exactly once:

```sh
SAGE_DSH_BIN=dsh \
SAGE_DSH_PROFILE=headless \
SAGE_DSH_VERSION=0.1.1-rc.2 \
pnpm --dir packages/dsh-sage-router run smoke:harness
```

The profile must have a working provider and credentials configured outside
the repository. The ordinary package test suite skips the real LLM case unless
`SAGE_LLM_SMOKE=1` is set.
