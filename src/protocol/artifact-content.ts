import { z } from 'zod';

export const artifactContentSchema = z
  .object({
    kind: z.enum(['text', 'file', 'patch', 'metadata']),
    content_ref: z.string().min(1),
    target_path: z.string().min(1).optional(),
    media_type: z.string().min(1).optional(),
  })
  .strict();

export type ArtifactContentView = z.infer<typeof artifactContentSchema>;
