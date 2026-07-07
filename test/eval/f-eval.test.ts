import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getInstanceReport, hasP2pRegression } from '../../eval/harness-report';
import { indexDatasetById, loadDataset } from '../../eval/load-dataset';
import { buildPrediction, writePredictionsJsonl } from '../../eval/prediction-writer';
import { runEvalInstance, runEvalSmoke } from '../../eval/run-instance-core';
import { runSweEvoHarnessAdapter } from '../../eval/sweevo-harness-adapter';
import type { SweEvoInstance } from '../../eval/types';
import { parsePredictionMode } from '../../eval/validation';

const SAMPLE_INSTANCE: SweEvoInstance = {
  repo: 'demo/repo',
  instance_id: 'demo__repo_1.0_1.1',
  base_commit: 'abc123',
  patch: 'diff --git a/README.md b/README.md\n',
  problem_statement: 'Fix the bug in demo repo.',
  FAIL_TO_PASS: ['tests/test_demo.py::test_fix'],
  PASS_TO_PASS: ['tests/test_demo.py::test_existing'],
};

describe('F eval utilities', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads dataset jsonl and builds oracle SWE-bench predictions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-dataset-'));
    tempDirs.push(dir);
    const jsonlPath = join(dir, 'test.jsonl');
    writeFileSync(jsonlPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const rows = await loadDataset(jsonlPath);
    const byId = indexDatasetById(rows);
    const prediction = buildPrediction(
      byId.get(SAMPLE_INSTANCE.instance_id)!,
      'mock-model',
      'oracle',
    );

    expect(prediction).toEqual({
      instance_id: SAMPLE_INSTANCE.instance_id,
      model_name_or_path: 'mock-model',
      model_patch: SAMPLE_INSTANCE.patch,
    });
  });

  it('writes predictions jsonl in SWE-bench format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-predictions-'));
    tempDirs.push(dir);
    const path = join(dir, 'predictions.jsonl');
    writePredictionsJsonl(path, [
      {
        instance_id: 'a',
        model_name_or_path: 'mock',
        model_patch: 'patch-a',
      },
    ]);

    expect(JSON.parse(readFileSync(path, 'utf-8').trim())).toEqual({
      instance_id: 'a',
      model_name_or_path: 'mock',
      model_patch: 'patch-a',
    });
  });

  it('rejects invalid prediction modes', () => {
    expect(() => parsePredictionMode('glod')).toThrow(/Invalid --mode/);
  });

  it('detects p2p regression from harness report', () => {
    const report = getInstanceReport(
      {
        'demo__repo_1.0_1.1': {
          resolved: false,
          patch_successfully_applied: true,
          tests_status: {
            PASS_TO_PASS: {
              'tests/test_demo.py::test_existing': 'FAILED',
            },
          },
        },
      },
      'demo__repo_1.0_1.1',
    );

    expect(hasP2pRegression(report)).toBe(true);
  });

  it('runs eval instance with scaffold baseline telemetry and oracle prediction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-run-'));
    tempDirs.push(dir);
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const result = await runEvalInstance({
      instanceId: SAMPLE_INSTANCE.instance_id,
      runId: 'unit_run',
      datasetPath,
      outRoot,
      predictionMode: 'oracle',
      memoryAblation: 'B2',
      modelName: 'mock-model',
    });

    const summary = JSON.parse(readFileSync(join(result.runDir, 'summary.json'), 'utf-8')) as {
      telemetry_event_types: string[];
      prediction_semantics: string;
      dataset_manifest_path: string;
    };
    const telemetryLines = readFileSync(result.summary.telemetry_path, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event_type: string });

    expect(summary.telemetry_event_types).toContain('task.created');
    expect(summary.telemetry_event_types).toContain('coord.checkpoint_observed');
    expect(summary.prediction_semantics).toBe('oracle_gold_patch_replay');
    expect(telemetryLines.some((record) => record.event_type === 'task.created')).toBe(true);
    expect(readFileSync(summary.dataset_manifest_path, 'utf-8')).toContain(
      SAMPLE_INSTANCE.instance_id,
    );

    const predictions = readFileSync(result.summary.predictions_path, 'utf-8').trim();
    expect(predictions).toContain(SAMPLE_INSTANCE.instance_id);
  });

  it('defaults eval instance to stub predictions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-default-stub-'));
    tempDirs.push(dir);
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const result = await runEvalInstance({
      instanceId: SAMPLE_INSTANCE.instance_id,
      runId: 'unit_stub_run',
      datasetPath,
      outRoot,
      skipScaffold: true,
    });

    const predictions = readFileSync(result.summary.predictions_path, 'utf-8');
    expect(result.summary.prediction_mode).toBe('stub');
    expect(predictions).toContain('F-direction pipeline stub');
  });

  it('prepares SWE-EVO OpenHands-compatible harness artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-harness-'));
    tempDirs.push(dir);
    const predictionsPath = join(dir, 'predictions.jsonl');
    const datasetPath = join(dir, 'test.jsonl');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');
    writePredictionsJsonl(predictionsPath, [
      {
        instance_id: SAMPLE_INSTANCE.instance_id,
        model_name_or_path: 'mock',
        model_patch: SAMPLE_INSTANCE.patch,
      },
    ]);

    process.env.NEWIDE_SCAFFOLD_ROOT = dir;
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'manifest.json'),
      JSON.stringify({
        dataset_version: 'unit',
        dataset_jsonl: 'test.jsonl',
        smoke_instance_ids: [SAMPLE_INSTANCE.instance_id],
        default_model_name: 'mock',
      }),
      'utf-8',
    );

    const result = await runSweEvoHarnessAdapter({
      predictionsPath,
      runId: 'adapter_run',
      outRoot: join(dir, 'runs'),
      sweEvoRoot: dir,
      dryRun: true,
    });

    expect(readFileSync(result.trajectoryPath, 'utf-8')).toContain('git_patch');
    expect(
      readFileSync(join(result.outputFinalDir, `${SAMPLE_INSTANCE.instance_id}.json`), 'utf-8'),
    ).toContain(SAMPLE_INSTANCE.instance_id);
    expect(readFileSync(result.commandPath, 'utf-8')).toContain('evaluate_instance.py');
    expect(JSON.parse(readFileSync(result.harnessReportPath, 'utf-8'))).toEqual({});
    delete process.env.NEWIDE_SCAFFOLD_ROOT;
  });

  it('runs smoke eval end-to-end for a pinned instance list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-smoke-'));
    tempDirs.push(dir);
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const results = await runEvalSmoke({
      runId: 'unit_smoke',
      datasetPath,
      outRoot,
      instanceIds: [SAMPLE_INSTANCE.instance_id],
      skipScaffold: true,
      predictionMode: 'stub',
    });

    expect(results).toHaveLength(1);
    const runDir = results[0]!.runDir;
    expect(readFileSync(join(runDir, 'dataset-manifest.json'), 'utf-8')).toContain(
      SAMPLE_INSTANCE.instance_id,
    );
    expect(readFileSync(join(runDir, 'summary.json'), 'utf-8')).toContain(
      'deterministic_stub_baseline',
    );
    expect(readFileSync(join(runDir, 'telemetry.jsonl'), 'utf-8')).toBe('');
  });
});
