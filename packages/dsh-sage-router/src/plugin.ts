import type { Context } from "@deepseek-ai/cordis";

import {
  Config as sagePluginConfigSchema,
  parseSagePluginConfig,
  type SagePluginConfig,
} from "./config.js";
import { ContextSubagentGateway } from "./harness/subagent-gateway.js";
import { SageRoutingService, type SageService } from "./service.js";
import { createSageOrchestrateTask } from "./tools/orchestrate-task.js";
import { createSageRouteTask } from "./tools/route-task.js";
import type { SageSessionLike } from "./persistence/events.js";
import {
  openSageLearningStore,
  type SageDomainFacility,
} from "./persistence/learning-store.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sage: SageService;
  }
}

export const name = "dsh-sage-router";
export const inject = ["tools", "subagents"];
export const Config = sagePluginConfigSchema;

export async function apply(ctx: Context, config?: SagePluginConfig): Promise<void> {
  if (config === undefined) {
    throw new Error("[SAGE_CONFIG_INVALID] plugin config is required");
  }
  const getOptional = (name: string): unknown =>
    (ctx as unknown as { get(name: string, strict?: boolean): unknown }).get(
      name,
      false,
    );
  const storageDomain = getOptional("storageDomain") as SageDomainFacility | undefined;
  const sessions = getOptional("sessions") as
    | { list(): ReadonlyArray<SageSessionLike & { events: readonly unknown[] }> }
    | undefined;
  const learningHandle = storageDomain === undefined
    ? undefined
    : await openSageLearningStore(storageDomain);
  try {
    const learningState = learningHandle === undefined
      ? undefined
      : await learningHandle.store.load();
    const service = new SageRoutingService(
      parseSagePluginConfig(config),
      new ContextSubagentGateway(ctx.subagents),
      {
        learningState,
        learningStore: learningHandle?.store,
      },
    );
    for (const session of sessions?.list() ?? []) {
      service.restoreSessionEvents(
        session.events,
        service.sessionAppenderFor(session),
      );
    }
    ctx.provide("sage", service);
    ctx.tools.register(createSageRouteTask(service));
    ctx.tools.register(createSageOrchestrateTask(service));
    if (learningHandle !== undefined) {
      ctx.effect(
        () => async () => {
          await learningHandle.close();
        },
        "sage learning store",
      );
    }
  } catch (error) {
    await learningHandle?.close();
    throw error;
  }
}

Object.assign(apply, { inject, Config });
