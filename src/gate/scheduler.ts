import type {
  GateRequest,
  GateResult,
  GateRunner,
  GateDefinition,
  GateScheduler,
  GateSchedulerOptions,
} from './gate';

export class PriorityGateScheduler implements GateScheduler {
  private definitions = new Map<string, GateDefinition>();
  private customRunners = new Map<string, GateRunner>();
  private queue: Array<{
    request: GateRequest;
    resolve: (result: GateResult) => void;
    reject: (error: unknown) => void;
    priority: number;
  }> = [];
  private activeCount = 0;
  private concurrency = 1;

  initialize(options: GateSchedulerOptions): void {
    if (options.definitions) {
      if (options.definitions instanceof Map) {
        this.definitions = options.definitions;
      } else {
        this.definitions = new Map(Object.entries(options.definitions));
      }
    }
    if (options.customRunners) {
      this.customRunners = options.customRunners;
    }
    if (options.concurrency !== undefined) {
      this.concurrency = options.concurrency;
    }
  }

  insert(request: GateRequest): Promise<GateResult> {
    return new Promise<GateResult>((resolve, reject) => {
      this.queue.push({
        request,
        resolve,
        reject,
        priority: request.priority ?? 0,
      });
      // Sort priority queue: highest priority first (descending order)
      this.queue.sort((a, b) => b.priority - a.priority);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;
    try {
      const result = await this.executeRequest(item.request);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeCount--;
      this.processQueue();
    }
  }

  private async executeRequest(request: GateRequest): Promise<GateResult> {
    // Check custom runners first
    let runner = this.customRunners.get(request.gate_id);
    if (!runner) {
      // Look up definition
      const definition = this.definitions.get(request.gate_id);
      if (!definition) {
        // Fallback for mocks
        if (request.gate_id === 'mock-allow-gate' || request.gate_id === 'allow-gate') {
          const { MockAllowGate } = await import('./mock-gate');
          runner = new MockAllowGate(request.gate_id);
        } else if (request.gate_id === 'mock-deny-gate' || request.gate_id === 'deny-gate') {
          const { MockDenyGate } = await import('./mock-gate');
          runner = new MockDenyGate(request.gate_id);
        } else {
          throw new Error(`No definition or custom runner found for gate_id: ${request.gate_id}`);
        }
      } else {
        // Build runner using BaseGateRunner.build
        const { BaseGateRunner } = await import('./runner');
        runner = BaseGateRunner.build(request.gate_id, definition, async (subGateId) =>
          this.resolveRunner(subGateId),
        );
      }
    }

    return runner.run(request);
  }

  private async resolveRunner(gateId: string): Promise<GateRunner> {
    const runner = this.customRunners.get(gateId);
    if (runner) return runner;

    const definition = this.definitions.get(gateId);
    if (!definition) {
      if (gateId === 'mock-allow-gate' || gateId === 'allow-gate') {
        const { MockAllowGate } = await import('./mock-gate');
        return new MockAllowGate(gateId);
      } else if (gateId === 'mock-deny-gate' || gateId === 'deny-gate') {
        const { MockDenyGate } = await import('./mock-gate');
        return new MockDenyGate(gateId);
      }
      throw new Error(`No definition or custom runner found for gate_id: ${gateId}`);
    }

    const { BaseGateRunner } = await import('./runner');
    return BaseGateRunner.build(gateId, definition, async (subGateId) =>
      this.resolveRunner(subGateId),
    );
  }
}
