/** Stable frontend-facing run event view model. */
import { z } from 'zod';

export const runEventSourceSchema = z.enum([
  'coordinator',
  'agent',
  'driver',
  'memory',
  'gate',
  'council',
]);

export type RunEventSource = z.infer<typeof runEventSourceSchema>;

export const runEventSchema = z
  .object({
    event_id: z.string().min(1),
    sequence: z.number().int().positive(),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    type: z.string().min(1),
    source: runEventSourceSchema,
    created_at: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    payload_ref: z.string().min(1).optional(),
    schema_version: z.string().min(1),
  })
  .strict();

export type RunEvent = z.infer<typeof runEventSchema>;

export function projectRunEventSource(type: string): RunEventSource {
  if (type.startsWith('agent.')) return 'agent';
  if (type.startsWith('driver.')) return 'driver';
  if (type.startsWith('memory.') || type.startsWith('buffer.')) return 'memory';
  if (type.startsWith('gate.')) return 'gate';
  if (type.startsWith('council.')) return 'council';
  return 'coordinator';
}
