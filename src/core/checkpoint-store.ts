import type { Checkpoint } from './checkpoint';
import type { CheckpointId, RunId } from './ids';

export interface CheckpointStore {
  /** 保存一个 checkpoint。重复 checkpoint_id：覆盖并视为幂等成功。 */
  save(checkpoint: Checkpoint): Checkpoint;

  /** 按 id 取单个 checkpoint。 */
  get(checkpointId: CheckpointId): Checkpoint | undefined;

  /** 取某 run 下最新的有效 checkpoint（created_at 最大且 validity_status !== 'superseded'）。无则 undefined。 */
  getLatestByRun(runId: RunId): Checkpoint | undefined;

  /** 列出某 run 的全部 checkpoint，按 created_at 升序。 */
  listByRun(runId: RunId): Checkpoint[];

  /** 列出全部 checkpoint（调试/审计用），按 created_at 升序。 */
  list(): Checkpoint[];
}
