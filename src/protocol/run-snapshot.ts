import { z } from 'zod';
import { runEventSchema } from './run-event';

const recordSchema = z.record(z.string(), z.unknown());

export const runSnapshotSchema = z
  .object({
    schema_version: z.string().min(1),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    mode: z.enum(['single_agent', 'council']),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    current: z
      .object({
        stage: z.enum(['executing', 'council', 'delivery', 'intervention']),
        active_node_code: z.string().min(1),
      })
      .strict(),
    timeline: z.array(runEventSchema),
    agent_runs: z.array(recordSchema),
    artifacts: z.array(recordSchema),
    gates: z.array(recordSchema),
    council: z
      .object({
        enabled: z.literal(true),
        status: z.enum(['running', 'completed', 'failed', 'cancelled']),
        decision_id: z.string().optional(),
        verdict: z.string().optional(),
        decision_mode: z.string().optional(),
        selected_proposal_id: z.string().optional(),
        selected_artifact_refs: z.array(z.string()),
        required_next_actions: z.array(z.string()),
        blocked_by: z.array(z.string()),
        can_create_merge_authorization: z.boolean(),
        proposals: z.array(recordSchema).optional(),
        reviews: z.array(recordSchema).optional(),
        synthesis: recordSchema.optional(),
        output: recordSchema.optional(),
      })
      .strict()
      .optional(),
    checkpoint: recordSchema.optional(),
    errors: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          details: recordSchema.optional(),
        })
        .strict(),
    ),
    final_output: z
      .object({
        status: z.enum(['completed', 'failed', 'cancelled']),
        artifact_refs: z.array(z.string()),
        files_written: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
