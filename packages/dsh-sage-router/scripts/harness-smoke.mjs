import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dshBin = process.env.SAGE_DSH_BIN ?? "dsh";
const profile = process.env.SAGE_DSH_PROFILE ?? "headless";
const expectedVersion = process.env.SAGE_DSH_VERSION ?? "0.1.1-rc.2";

function fail(message) {
  throw new Error(`[SAGE_HARNESS_SMOKE_FAILED] ${message}`);
}

async function run(args, timeout = 30_000) {
  try {
    return await execFileAsync(dshBin, args, {
      env: process.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout,
    });
  } catch (error) {
    const code = error?.code === undefined ? "unknown" : String(error.code);
    fail(`${dshBin} ${args.join(" ")} exited with ${code}`);
  }
}

const version = await run(["--version"]);
if (version.stdout.trim() !== expectedVersion) {
  fail(`expected Harness ${expectedVersion}, found ${version.stdout.trim()}`);
}

await run(["plugin", "--profile", profile, "add", packageRoot], 120_000);
const config = await run(["--profile", profile, "--dump-config"]);
const configText = `${config.stdout}\n${config.stderr}`;
for (const marker of [
  "@jinzheng8115/dsh-sage-router",
  "id: sage-router",
  "autoOrchestrate: false",
  "maxDelegationDepth: 1",
  "defaultBudget: 0.3",
  "defaultDeadlineMs: 4000",
]) {
  if (!configText.includes(marker)) fail(`dumped profile is missing ${marker}`);
}

const task = [
  "Use the sage_route_task tool exactly once.",
  'Call it with task {"taskId":"fixed-harness-smoke","requirements":[{"name":"general"}]}.',
  "After the tool returns successfully, reply exactly SAGE_ROUTE_SMOKE_OK.",
  "Do not call any other tool.",
].join(" ");
const result = await run(["--profile", profile, task], 120_000);
if (!`${result.stdout}\n${result.stderr}`.includes("SAGE_ROUTE_SMOKE_OK")) {
  fail("the model completed without SAGE_ROUTE_SMOKE_OK");
}

const packageManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
if (packageManifest.dsh?.bundle?.patch !== "./cordis.patch.yml") {
  fail("the package does not declare its bundle patch");
}

console.log(`Harness ${expectedVersion} bundle install and route smoke passed for profile ${profile}`);
