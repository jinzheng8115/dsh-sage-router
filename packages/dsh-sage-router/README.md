# dsh-sage-router

SAGE routing as a DeepSeek Harness plugin. The plugin exposes
`sage_route_task` and `sage_orchestrate_task`, and keeps model/provider
credentials in the host Harness profile; no credential is stored in this
package.

## Real LLM smoke

The fixed smoke baseline is `@deepseek-ai/dsh 0.1.1-rc.2`. Build and install
the bundle into a profile, then run the opt-in install/config/model smoke:

```sh
pnpm install --frozen-lockfile
pnpm run build
SAGE_DSH_BIN=dsh SAGE_DSH_PROFILE=headless SAGE_DSH_VERSION=0.1.1-rc.2 pnpm run smoke:harness
```

`SAGE_DSH_BIN` is useful when more than one global `dsh` installation is on
`PATH`. The command must point to the same Harness CLI/profile that owns the
configured provider and credentials. `smoke:harness` runs `dsh plugin add`,
verifies `--dump-config`, checks the fixed CLI version, and asks the real model
to call `sage_route_task` once.

The ordinary `pnpm test` suite skips the model call unless
`SAGE_LLM_SMOKE=1` is set.

## Subagent execution

The plugin exposes `sage_orchestrate_task`. Keep `autoOrchestrate: false` for
route-only operation. When enabled, each declared agent may set `provider` and
`model` for its LLM, plus `subagentProvider: spawn` or `fork` for the Harness
child backend. `maxDelegationDepth` defaults to `1` and is passed to the
Harness depth-limit seam. Child cancellation, tool filtering, and lifecycle
ownership remain enforced by `ctx.subagents`.

## Event persistence and recovery

When the calling Agent has a Harness session, the plugin can append four
log-only event types: `sage/route`, `sage/execution`, `sage/outcome`, and
`sage/model-update`. They contain route identifiers, declared Agent IDs,
requirement names, scores, costs, latency, error codes, and numeric learning
state only; prompts, credentials, files, tool arguments, and child transcripts
are not persisted by SAGE.

These session-log appends are **off by default** (`sessionEventLog: false`).
Harness builds that do not know the `sage/*` types refuse to resume any
session whose log contains them unless each event is marked `ignorable`, and
current Harness releases give plugins no way to set that marker — writing
unmarked custom events permanently breaks resume for that session. Enable
`sessionEventLog: true` only on a Harness that natively supports these types
or ignorable/registered custom events. Learning state does not depend on this
option: it is stored through the storage domain regardless.

If the Harness storage-domain service is loaded, the plugin stores the latest
learning snapshot under the `sage_router_learning` domain. Revisions use
compare-and-set semantics, so a stale process cannot overwrite newer learning.
Session events (when present, including historical logs) can be folded to
restore route assignments and the last consistent learning revision. If an
append or flush fails, orchestration returns `persistenceUncertain: true`
instead of reporting a durable success.
