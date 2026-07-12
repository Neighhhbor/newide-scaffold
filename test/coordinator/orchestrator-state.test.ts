import { describe, expect, it } from 'vitest';
import { RuntimeOrchestrator } from '../../src/coordinator/orchestrator';

describe('RuntimeOrchestrator task lifecycle', () => {
  it('enforces canonical task status transitions', () => {
    const orchestrator = new RuntimeOrchestrator();
    const task = orchestrator.createTask({
      spec: 'Enforce runtime lifecycle',
      completion_criteria: ['Invalid transitions are rejected'],
    });

    expect(() => orchestrator.updateTaskStatus(task.task_id, 'running')).toThrow(
      'Invalid task status transition: created -> running',
    );
    expect(orchestrator.updateTaskStatus(task.task_id, 'claimed').status).toBe('claimed');
    expect(orchestrator.updateTaskStatus(task.task_id, 'running').status).toBe('running');
    expect(orchestrator.updateTaskStatus(task.task_id, 'reviewing').status).toBe('reviewing');
    expect(orchestrator.updateTaskStatus(task.task_id, 'merging').status).toBe('merging');
    expect(orchestrator.updateTaskStatus(task.task_id, 'completed').status).toBe('completed');
  });
});
