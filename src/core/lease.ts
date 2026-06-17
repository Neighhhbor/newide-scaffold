import type { LeaseId, SchemaVersion, Timestamp } from './ids';

export type LeaseScope = 'read' | 'write';
export type LeaseStatus = 'active' | 'released' | 'expired' | 'conflicted';

export interface FileLease {
  lease_id: LeaseId;
  holder_id: string;
  path_glob: string;
  scope: LeaseScope;
  expires_at: Timestamp;
  status: LeaseStatus;
  schema_version: SchemaVersion;
}

export type PathLease = FileLease;
