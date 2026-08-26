import {
  validateLearningState,
  type SageLearningState,
} from "./events.js";

export interface SageLearningStore {
  load(): Promise<SageLearningState | undefined>;
  save(expectedRevision: number, state: SageLearningState): Promise<void>;
}

export class SageStaleRevisionError extends Error {
  public readonly code = "SAGE_STALE_LEARNING_REVISION";

  public constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    const code = "SAGE_STALE_LEARNING_REVISION";
    super(
      `[${code}] expected revision ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "SageStaleRevisionError";
  }
}

export class InMemorySageLearningStore implements SageLearningStore {
  private state: SageLearningState | undefined;

  public constructor(initial?: SageLearningState) {
    this.state = initial === undefined ? undefined : validateLearningState(initial);
  }

  public async load(): Promise<SageLearningState | undefined> {
    return this.state === undefined ? undefined : validateLearningState(this.state);
  }

  public async save(
    expectedRevision: number,
    state: SageLearningState,
  ): Promise<void> {
    const currentRevision = this.state?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new SageStaleRevisionError(expectedRevision, currentRevision);
    }
    const next = validateLearningState(state);
    if (next.revision !== expectedRevision + 1) {
      throw new Error(
        `learning state revision must advance from ${expectedRevision} to ${expectedRevision + 1}`,
      );
    }
    this.state = next;
  }
}

export interface SageDomainTable {
  get(key: string): unknown;
  put(key: string, value: unknown): Promise<void>;
  update(key: string, update: (current: unknown) => unknown): Promise<unknown>;
}

export interface SageDomainHandle {
  table(name: string): SageDomainTable;
  close(): Promise<void>;
}

export interface SageDomainFacility {
  open(spec: SageDomainSpec): Promise<SageDomainHandle>;
}

export interface SageDomainSpec {
  readonly name: string;
  readonly version: number;
  readonly tables: Readonly<Record<string, { valueSchema: SageValueSchema }>>;
}

interface SageValueSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false };
  parse(value: unknown): unknown;
}

class StorageDomainLearningStore implements SageLearningStore {
  private readonly table: SageDomainTable;

  public constructor(domain: SageDomainHandle) {
    this.table = domain.table("state");
  }

  public async load(): Promise<SageLearningState | undefined> {
    const value = this.table.get("global");
    return value === undefined ? undefined : validateLearningState(value);
  }

  public async save(
    expectedRevision: number,
    state: SageLearningState,
  ): Promise<void> {
    const next = validateLearningState(state);
    const current = this.table.get("global");
    const currentRevision =
      current === undefined ? 0 : validateLearningState(current).revision;
    if (currentRevision !== expectedRevision) {
      throw new SageStaleRevisionError(expectedRevision, currentRevision);
    }
    if (next.revision !== expectedRevision + 1) {
      throw new Error(
        `learning state revision must advance from ${expectedRevision} to ${expectedRevision + 1}`,
      );
    }
    if (current === undefined) {
      await this.table.put("global", next);
      return;
    }
    await this.table.update("global", (latest) => {
      const latestRevision = validateLearningState(latest).revision;
      if (latestRevision !== expectedRevision) {
        throw new SageStaleRevisionError(expectedRevision, latestRevision);
      }
      return next;
    });
  }
}

export interface SageLearningStoreHandle {
  store: SageLearningStore;
  close(): Promise<void>;
}

export async function openSageLearningStore(
  facility: SageDomainFacility,
): Promise<SageLearningStoreHandle> {
  const domain = await facility.open(sageLearningDomainSpec);
  return {
    store: new StorageDomainLearningStore(domain),
    close: () => domain.close(),
  };
}

const sageLearningStateSchema: SageValueSchema = {
  safeParse(value) {
    try {
      return { success: true, data: validateLearningState(value) };
    } catch {
      return { success: false };
    }
  },
  parse(value) {
    return validateLearningState(value);
  },
};

export const sageLearningDomainSpec: SageDomainSpec = {
  // Harness storage unit names accept lowercase letters, digits, and
  // underscores only; hyphenated names fail during plugin boot.
  name: "sage_router_learning",
  version: 1,
  tables: {
    state: { valueSchema: sageLearningStateSchema },
  },
};
