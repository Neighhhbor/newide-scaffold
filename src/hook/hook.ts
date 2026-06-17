import { SCHEMA_VERSION, createId, nowTimestamp, type Event } from '../core';
import {
  DecisionAggregator,
  type GateDecision,
  type GateRequest,
  type GateResult,
  type GateRunner,
  MockAllowGate,
} from '../gate';

export type HookPoint = 'task.completed' | 'before_merge';

export interface HookEvent extends Event {
  event_type: HookPoint | (string & {});
}

export interface HookBinding {
  hook_point: HookPoint;
  gate_id: string;
  priority: number;
  denying: boolean;
  timeout_ms: number;
  schema_version: typeof SCHEMA_VERSION;
}

export interface HookResult {
  hook_point: HookPoint | string;
  matched: boolean;
  gate_requests: GateRequest[];
  gate_results: GateResult[];
  final_decision: GateDecision;
  created_at: string;
  schema_version: typeof SCHEMA_VERSION;
}

export interface HookEngineOptions {
  bindings: HookBinding[];
  gates: GateRunner[];
  aggregator?: DecisionAggregator;
}

export class HookEngine {
  private readonly bindings: HookBinding[];
  private readonly gates: Map<string, GateRunner>;
  private readonly aggregator: DecisionAggregator;

  constructor(options: HookEngineOptions) {
    this.bindings = options.bindings;
    this.gates = new Map(options.gates.map((gate) => [gate.gate_id, gate]));
    this.aggregator = options.aggregator ?? new DecisionAggregator();
  }

  async handleEvent(event: HookEvent): Promise<HookResult> {
    const matchedBindings = this.bindings
      .filter((binding) => binding.hook_point === event.event_type)
      .sort((left, right) => right.priority - left.priority);

    if (matchedBindings.length === 0) {
      return {
        hook_point: event.event_type,
        matched: false,
        gate_requests: [],
        gate_results: [],
        final_decision: 'allow',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
    }

    const gateRequests = matchedBindings.map((binding) => this.toGateRequest(event, binding));
    const gateResults: GateResult[] = [];

    for (const request of gateRequests) {
      const gate = this.gates.get(request.gate_id);
      if (!gate) {
        throw new Error(`No gate runner registered for ${request.gate_id}`);
      }
      gateResults.push(await gate.run(request));
    }

    return {
      hook_point: event.event_type,
      matched: true,
      gate_requests: gateRequests,
      gate_results: gateResults,
      final_decision: this.aggregator.aggregate(gateResults).decision,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  private toGateRequest(event: HookEvent, binding: HookBinding): GateRequest {
    return {
      gate_id: binding.gate_id,
      gate_point: binding.hook_point,
      subject_id: event.subject_id,
      priority: binding.priority,
      denying: binding.denying,
      timeout_ms: binding.timeout_ms,
      created_at: nowTimestamp(),
      payload: {
        event_id: event.event_id,
        event_type: event.event_type,
        task_id: event.task_id,
        run_id: event.run_id,
        ...event.payload,
      },
      schema_version: SCHEMA_VERSION,
    };
  }
}

export function createDefaultHookEngine(): HookEngine {
  return new HookEngine({
    bindings: [
      {
        hook_point: 'task.completed',
        gate_id: 'mock-allow-gate',
        priority: 100,
        denying: true,
        timeout_ms: 30000,
        schema_version: SCHEMA_VERSION,
      },
      {
        hook_point: 'before_merge',
        gate_id: 'mock-allow-gate',
        priority: 100,
        denying: true,
        timeout_ms: 30000,
        schema_version: SCHEMA_VERSION,
      },
    ],
    gates: [new MockAllowGate('mock-allow-gate')],
  });
}

export function createHookEvent(
  input: Omit<HookEvent, 'event_id' | 'created_at' | 'schema_version'>,
): HookEvent {
  return {
    ...input,
    event_id: createId('event'),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
