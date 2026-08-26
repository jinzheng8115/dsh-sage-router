import type { SageDecision, SageExecutionState, SageOutcome } from "../core/types.js";
import {
  parseSageStoredEvent,
  type SageExecutionEvent,
  type SageLearningState,
  type SageStoredEvent,
} from "./events.js";

export type SageFoldRouteStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "replanned";

export interface SageFoldedRoute {
  routeId: string;
  taskId: string;
  decision: SageDecision;
  activeState?: SageExecutionState;
  status: SageFoldRouteStatus;
  execution: Readonly<Record<string, SageExecutionEvent>>;
  outcome?: {
    routeId: string;
    outcome: SageOutcome;
  };
  modelUpdate?: SageLearningState;
}

export interface SageFoldedState {
  routes: Readonly<Record<string, SageFoldedRoute>>;
  learningState?: SageLearningState;
  revision: number;
}

export function foldSageEvents(events: readonly unknown[]): SageFoldedState {
  const routes: Record<string, SageFoldedRoute> = {};
  let learningState: SageLearningState | undefined;
  let revision = 0;

  for (const candidate of events) {
    if (!isEventLike(candidate)) continue;
    if (!candidate.type.startsWith("sage/")) continue;
    const event = parseSageStoredEvent(candidate);
    switch (event.type) {
      case "sage/route": {
        const previous = routes[event.data.routeId];
        routes[event.data.routeId] = {
          routeId: event.data.routeId,
          taskId: event.data.taskId,
          decision: event.data.decision,
          ...(event.data.activeState === undefined
            ? {}
            : { activeState: event.data.activeState }),
          status: previous === undefined ? "planned" : "replanned",
          execution: previous?.execution ?? {},
          ...(previous?.outcome === undefined
            ? {}
            : { outcome: previous.outcome }),
          ...(previous?.modelUpdate === undefined
            ? {}
            : { modelUpdate: previous.modelUpdate }),
        };
        break;
      }
      case "sage/execution": {
        const route = requireRoute(routes, event.data.routeId);
        const execution = {
          ...route.execution,
          [event.data.requirement]: event.data,
        };
        routes[event.data.routeId] = {
          ...route,
          status: executionStatus(route.decision, execution),
          execution,
        };
        break;
      }
      case "sage/outcome": {
        const route = requireRoute(routes, event.data.routeId);
        routes[event.data.routeId] = {
          ...route,
          status:
            typeof event.data.outcome.success === "boolean"
              ? event.data.outcome.success
                ? "completed"
                : "failed"
              : route.status,
          outcome: event.data,
        };
        break;
      }
      case "sage/model-update": {
        const route = requireRoute(routes, event.data.routeId);
        if (event.data.state.revision <= revision) {
          throw new Error(
            `SAGE model revision must increase: ${event.data.state.revision} <= ${revision}`,
          );
        }
        revision = event.data.state.revision;
        learningState = event.data.state;
        routes[event.data.routeId] = {
          ...route,
          modelUpdate: event.data.state,
        };
        break;
      }
    }
  }

  return { routes, ...(learningState === undefined ? {} : { learningState }), revision };
}

export function foldSageRoute(
  events: readonly unknown[],
  routeId: string,
): SageFoldedRoute | undefined {
  return foldSageEvents(events).routes[routeId];
}

function requireRoute(
  routes: Readonly<Record<string, SageFoldedRoute>>,
  routeId: string,
): SageFoldedRoute {
  const route = routes[routeId];
  if (route === undefined) {
    throw new Error(`SAGE event references an unknown route: ${routeId}`);
  }
  return route;
}

function executionStatus(
  decision: SageDecision,
  execution: Readonly<Record<string, SageExecutionEvent>>,
): SageFoldRouteStatus {
  const events = Object.values(execution);
  if (events.some((event) => event.status === "aborted")) return "aborted";
  if (events.some((event) => event.status === "failed")) return "failed";
  const requirements = Object.keys(decision.assignments);
  if (
    requirements.length > 0 &&
    requirements.every((name) => execution[name]?.status === "completed")
  ) {
    return "completed";
  }
  return events.some((event) => event.status === "started") ? "running" : "planned";
}

function isEventLike(value: unknown): value is { type: string; data: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    "data" in value
  );
}
