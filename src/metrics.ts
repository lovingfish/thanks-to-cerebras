type CounterMap = Map<string, number>;

export class Metrics {
  private counters = new Map<string, CounterMap>();

  inc(name: string, label: string, delta = 1): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = new Map();
      this.counters.set(name, counter);
    }
    counter.set(label, (counter.get(label) ?? 0) + delta);
  }

  snapshot(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const [name, counter] of this.counters) {
      const labels: Record<string, number> = {};
      for (const [label, value] of counter) {
        labels[label] = value;
      }
      result[name] = labels;
    }
    return result;
  }

  reset(): void {
    this.counters.clear();
  }
}

export const metrics = new Metrics();
