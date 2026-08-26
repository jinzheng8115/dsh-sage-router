import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

test("bundle manifest points to the built ESM entry and patch layer", () => {
  const manifest = readJson(resolve(packageRoot, "package.json"));

  equal(manifest.name, "@jinzheng8115/dsh-sage-router");
  equal(manifest.type, "module");
  equal(manifest.engines.node, ">=22");
  equal(manifest.exports["."].import, "./dist/src/index.js");
  equal(manifest.exports["."].types, "./dist/src/index.d.ts");
  deepStrictEqual(manifest.files, ["dist", "cordis.patch.yml", "README.md"]);
  equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  ok(existsSync(resolve(packageRoot, "dist/src/index.js")));
  ok(existsSync(resolve(packageRoot, "dist/src/index.d.ts")));

  const patch = readFileSync(resolve(packageRoot, "cordis.patch.yml"), "utf8");
  match(patch, /id:\s+sage-router/);
  match(patch, /name:\s+'@jinzheng8115\/dsh-sage-router'/);
  match(patch, /autoOrchestrate:\s+false/);
  match(patch, /maxDelegationDepth:\s+1/);
  match(patch, /defaultBudget:\s+0\.3/);
  match(patch, /defaultDeadlineMs:\s+4000/);
});

test("repository documents and CI pin the tested Harness baseline", () => {
  const docs = readFileSync(resolve(repositoryRoot, "docs/SAGE-HARNESS.md"), "utf8");
  const workflow = readFileSync(
    resolve(repositoryRoot, ".github/workflows/tests.yml"),
    "utf8",
  );

  match(docs, /0\.1\.1-rc\.2/);
  match(docs, /sage_route_task/);
  match(docs, /sage_orchestrate_task/);
  match(workflow, /SAGE_DSH_VERSION:\s+0\.1\.1-rc\.2/);
  match(workflow, /smoke:harness/);
});
