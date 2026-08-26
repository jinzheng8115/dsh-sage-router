import { execFile } from "node:child_process";
import { ok } from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const smokeEnabled = process.env.SAGE_LLM_SMOKE === "1";

test(
  "real Harness LLM can invoke sage_route_task",
  { skip: !smokeEnabled },
  async () => {
    const dshBin = process.env.SAGE_DSH_BIN ?? "dsh";
    const profile = process.env.SAGE_DSH_PROFILE ?? "headless";
    const task = [
      "Use the sage_route_task tool exactly once.",
      'Call it with task {"taskId":"llm-smoke","requirements":[{"name":"general"}]}.',
      "After the tool returns successfully, reply exactly SAGE_ROUTE_SMOKE_OK.",
      "Do not call any other tool.",
    ].join(" ");

    let result: { stdout: string; stderr: string };
    try {
      result = await execFileAsync(dshBin, ["--profile", profile, task], {
        env: process.env,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      });
    } catch {
      throw new Error(`Harness LLM smoke failed for ${dshBin} profile ${profile}`);
    }
    ok(
      `${result.stdout}\n${result.stderr}`.includes("SAGE_ROUTE_SMOKE_OK"),
      "the model completed without the smoke marker",
    );
  },
);
