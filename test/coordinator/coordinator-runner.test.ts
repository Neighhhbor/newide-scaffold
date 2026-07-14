import { describe, expect, it, vi } from 'vitest';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { IntegrationV0CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import { MockDriver } from '../../src/driver';

describe('IntegrationV0CoordinatorRunner', () => {
  it('maps the stable runner request to integration-v0 dependencies', async () => {
    const driver = new MockDriver();
    const flow = vi.fn(async () => ({ run_id: 'run_1' }) as IntegrationV0Result);
    const runner = new IntegrationV0CoordinatorRunner({ driver }, flow);
    const onRunCreated = vi.fn();
    const onEvent = vi.fn();
    const controller = new AbortController();

    await runner.run({
      prompt: 'Build RPC',
      mode: 'council',
      workspace_path: process.cwd(),
      session_id: 'session_existing',
      onRunCreated,
      onEvent,
      signal: controller.signal,
    });

    expect(flow).toHaveBeenCalledWith({
      driver,
      driverPrompt: 'Build RPC',
      enableCouncil: true,
      workspacePath: process.cwd(),
      sessionId: 'session_existing',
      onRunCreated,
      onEvent,
      signal: controller.signal,
    });
  });
});
