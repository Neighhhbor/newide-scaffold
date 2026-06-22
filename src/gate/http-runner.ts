import { BaseGateRunner } from './runner';
import type { GateRequest, GateResult, GateDefinition } from './gate';

export class HttpRunner extends BaseGateRunner {
  constructor(
    gate_id: string,
    private readonly definition: GateDefinition,
  ) {
    super(gate_id);
  }

  async run(request: GateRequest): Promise<GateResult> {
    const url = this.definition.input;
    return this.buildResult(
      request,
      'allow',
      `HttpRunner fallback (URL: ${url ?? 'none'}). HTTP gates are handled as fallback.`,
      {
        required_actions: [],
        audit_ref: `audit://http/${this.gate_id}/${request.request_id}`,
      },
    );
  }
}
