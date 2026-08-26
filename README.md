# dsh-sage-router

SAGE routing as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: progress-aware constrained routing (SELF / HANDOFF / COLLABORATE) and task-DAG scheduling for A2A agent networks.

The package lives in [`packages/dsh-sage-router`](packages/dsh-sage-router) and exposes two agent tools:

- `sage_route_task` — filter declared Agents and return a routing decision only; no child Agent is started.
- `sage_orchestrate_task` — same route seam, then optionally execute each requirement through Harness subagents (`autoOrchestrate`), with replanning after a failed child.

## Install a local bundle

```sh
pnpm --dir packages/dsh-sage-router install --frozen-lockfile
pnpm --dir packages/dsh-sage-router build
dsh plugin --profile <name> add ./packages/dsh-sage-router
```

The bundle ships safe route-only defaults (`autoOrchestrate: false`). To enable real child execution, add an id-targeted patch for the `sage-router` row in the profile's `cordis.patch.yml`; id-targeted patches replace the row's whole config object, so restate every key. See [`docs/SAGE-HARNESS.md`](docs/SAGE-HARNESS.md) for tool contracts, persistence, and security limits.

## Verify

```sh
pnpm --dir packages/dsh-sage-router run check          # build + typecheck + tests
SAGE_DSH_BIN=dsh SAGE_DSH_PROFILE=<profile> \
SAGE_DSH_VERSION=0.1.1-rc.2 \
  pnpm --dir packages/dsh-sage-router run smoke:harness  # opt-in real-model smoke
```

## Compatibility baseline

`@deepseek-ai/dsh 0.1.1-rc.2`, Node.js 22+, pnpm 10+. The plugin stores no credentials; the selected Harness profile must own its provider, model, approval, sandbox, and credential configuration.

## License

MIT — see [LICENSE](LICENSE).
