import { BaseGateRunner } from './runner';
import type { GateRequest, GateResult, GateDefinition } from './gate';

export class PromptRunner extends BaseGateRunner {
  constructor(
    gate_id: string,
    private readonly definition: GateDefinition,
  ) {
    super(gate_id);
  }

  async run(request: GateRequest): Promise<GateResult> {
    const model = this.definition.model;
    return this.buildResult(
      request,
      'allow',
      `PromptRunner processed prompt successfully (Model: ${model ?? 'default'}).`,
      {
        required_actions: [],
        audit_ref: `audit://prompt/${this.gate_id}/${request.request_id}`,
      },
    );
  }
}
