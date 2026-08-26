import type {
  BetaBeliefSnapshot,
  OnlineSuccessModelSnapshot,
} from "./types.js";

export function clip(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value));
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

export interface RandomSource {
  next(): number;
}

export class SeededRandom implements RandomSource {
  private state: number;

  public constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x100000000;
  }
}

export class BetaBelief {
  public constructor(
    public alpha = 2,
    public beta = 2,
  ) {}

  public get mean(): number {
    return this.alpha / (this.alpha + this.beta);
  }

  public get uncertainty(): number {
    const total = this.alpha + this.beta;
    return Math.sqrt(
      (this.alpha * this.beta) / (total * total * (total + 1)),
    );
  }

  public draw(random: RandomSource): number {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const x = random.next() ** (1 / this.alpha);
      const y = random.next() ** (1 / this.beta);
      const total = x + y;
      if (total > 0 && total <= 1) {
        return x / total;
      }
    }
    return this.mean;
  }

  public update(score: number | boolean, weight = 1): void {
    const value = Number(score);
    if (value < 0 || value > 1 || Number.isNaN(value)) {
      throw new Error("belief update score must be in [0, 1]");
    }
    if (weight <= 0 || Number.isNaN(weight)) {
      throw new Error("belief update weight must be positive");
    }
    this.alpha += weight * value;
    this.beta += weight * (1 - value);
  }

  public snapshot(): BetaBeliefSnapshot {
    return { alpha: this.alpha, beta: this.beta };
  }

  public static fromSnapshot(snapshot: BetaBeliefSnapshot): BetaBelief {
    return new BetaBelief(snapshot.alpha, snapshot.beta);
  }
}

export class OnlineSuccessModel {
  public learningRate: number;
  public l2: number;
  public updates: number;
  public bias: number;
  public weights: Record<string, number>;

  public constructor(
    learningRate = 0.08,
    l2 = 0.001,
    updates = 0,
    bias = -1.15,
    weights: Record<string, number> = {
      coverage: 2.35,
      bottleneck: 1.35,
      trust: 0.8,
      synergy: 0.35,
      redundancy: -0.45,
      coordination_loss: -0.55,
      handoff_loss: -0.7,
      switch_loss: -0.55,
      load: -0.35,
    },
  ) {
    this.learningRate = learningRate;
    this.l2 = l2;
    this.updates = updates;
    this.bias = bias;
    this.weights = { ...weights };
  }

  public predict(features: Readonly<Record<string, number>>): number {
    let logit = this.bias;
    for (const [name, value] of Object.entries(features)) {
      logit += (this.weights[name] ?? 0) * value;
    }
    return clip(sigmoid(logit), 0.01, 0.99);
  }

  public update(
    features: Readonly<Record<string, number>>,
    outcome: number,
  ): void {
    const prediction = this.predict(features);
    const error = clip(outcome) - prediction;
    const rate = this.learningRate / Math.sqrt(1 + this.updates / 50);
    this.bias += rate * error;
    for (const name of Object.keys(this.weights)) {
      const value = features[name] ?? 0;
      this.weights[name] +=
        rate * (error * value - this.l2 * this.weights[name]);
    }
    this.updates += 1;
  }

  public snapshot(): OnlineSuccessModelSnapshot {
    return {
      learningRate: this.learningRate,
      l2: this.l2,
      updates: this.updates,
      bias: this.bias,
      weights: { ...this.weights },
    };
  }
}
