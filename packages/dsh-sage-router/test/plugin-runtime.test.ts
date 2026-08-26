import { equal, match, ok, rejects } from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRegistry from "@deepseek-ai/dsh-tools";

import { parseSagePluginConfig } from "../src/config.js";
import { apply as sagePlugin, inject, name } from "../src/plugin.js";

const config = parseSagePluginConfig({
  agents: [
    {
      agentId: "self",
      provider: "local",
      skills: { general: 0.9 },
      cost: 1,
      latencyMs: 100,
      permissions: ["task.execute"],
    },
  ],
  incumbentId: "self",
});

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .join("");
}

test("exports the Harness plugin metadata", () => {
  equal(name, "dsh-sage-router");
  deepEqualStrings(inject, ["tools", "subagents"]);
});

test("loads into real Cordis, routes through ctx.tools, and unloads cleanly", async () => {
  const app = new Context();
  const promptFiber = app.plugin(SystemPrompt);
  await promptFiber.await();
  const toolsFiber = app.plugin(ToolRegistry);
  await toolsFiber.await();
  app.provide("subagents", {
    start: async () => {
      throw new Error("not expected in route-only runtime test");
    },
  });
  const pluginFiber = app.plugin(sagePlugin, config);
  await pluginFiber.await();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const schemas = app.tools.schemas();
  equal(schemas.filter((schema) => schema.name === "sage_route_task").length, 1);
  equal(schemas.filter((schema) => schema.name === "sage_orchestrate_task").length, 1);
  ok(app.get("sage"));

  const result = await app.tools.execute({
    callId: CallId("sage-runtime-test"),
    name: "sage_route_task",
    arguments: {
      task: {
        taskId: "harness-route",
        requirements: [{ name: "general" }],
      },
    },
    signal: new AbortController().signal,
  });

  equal(result.isError, false);
  match(textOf(result), /SELF/);
  match(textOf(result), /route/);

  const planned = await app.tools.execute({
    callId: CallId("sage-runtime-plan-only"),
    name: "sage_orchestrate_task",
    arguments: {
      task: {
        taskId: "harness-plan",
        requirements: [{ name: "general" }],
      },
    },
    signal: new AbortController().signal,
  });
  equal(planned.isError, false);
  match(textOf(planned), /planned/);

  const invalidArguments = await app.tools.execute({
    callId: CallId("sage-runtime-invalid-args"),
    name: "sage_route_task",
    arguments: {
      task: {
        taskId: "harness-route",
        requirements: [{ name: "general" }],
      },
      prompt: "must not cross the route seam",
    },
    signal: new AbortController().signal,
  });
  equal(invalidArguments.isError, true);
  match(textOf(invalidArguments), /SAGE_ROUTE_INVALID_INPUT/);

  await pluginFiber.dispose();
  equal(app.tools.schemas().some((schema) => schema.name === "sage_route_task"), false);
  equal(app.tools.schemas().some((schema) => schema.name === "sage_orchestrate_task"), false);
  equal(app.get("sage"), undefined);
  await toolsFiber.dispose();
  await promptFiber.dispose();
});

test("rejects invalid plugin configuration before registering the service", async () => {
  const app = new Context();
  const promptFiber = app.plugin(SystemPrompt);
  await promptFiber.await();
  const toolsFiber = app.plugin(ToolRegistry);
  await toolsFiber.await();
  app.provide("subagents", {
    start: async () => {
      throw new Error("not expected in invalid config test");
    },
  });

  const invalidFiber = app.plugin(sagePlugin, {
    ...config,
    agents: [...config.agents, config.agents[0]!],
  });
  await rejects(() => invalidFiber.await(), /duplicate agent_id/);
  equal(app.get("sage"), undefined);
  equal(app.tools.schemas().some((schema) => schema.name === "sage_route_task"), false);

  await toolsFiber.dispose();
  await promptFiber.dispose();
});

function deepEqualStrings(actual: readonly string[], expected: readonly string[]): void {
  equal(JSON.stringify(actual), JSON.stringify(expected));
}
