import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBasicFlow } from '../src/coordinator/basic-flow';
import { CompositeTelemetrySink, JsonlTelemetrySink } from '../src/telemetry/jsonl-telemetry-sink';
import { createFHarnessTelemetryPort } from '../src/telemetry/harness-port';
import { InMemoryTelemetrySink } from '../src/telemetry/telemetry-sink';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from './load-dataset';
import { loadDatasetSubset, loadManifest, resolveDatasetJsonl, resolveRunDir } from './paths';
import { buildPrediction, writePredictionsJsonl } from './prediction-writer';
import { getInstanceReport, hasP2pRegression, readHarnessReport } from './harness-report';
import { buildEvalSummary, writeJson, writeRunMeta } from './run-summary';
import type { EvalRunMeta, EvalSummary, MemoryAblation, PredictionMode } from './types';
import { describePredictionMode, normalizePredictionMode } from './validation';

export interface RunInstanceOptions {
  instanceId: string;
  runId?: string;
  predictionMode?: PredictionMode;
  memoryAblation?: MemoryAblation;
  modelName?: string;
  datasetPath?: string;
  datasetSubset?: string;
  outRoot?: string;
  skipScaffold?: boolean;
  harnessReportPath?: string;
  instanceSeq?: number;
  patchFile?: string;
  modelPatch?: string;
}

export interface RunInstanceResult {
  runDir: string;
  summary: EvalSummary;
  runMeta: EvalRunMeta;
}

function createRunId(instanceId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}_${instanceId}`;
}

export async function runEvalInstance(options: RunInstanceOptions): Promise<RunInstanceResult> {
  const manifest = loadManifest();
  const datasetPath = resolveDatasetJsonl(manifest, options.datasetPath);
  const instances = indexDatasetById(await loadDataset(datasetPath));
  const instance = getInstanceOrThrow(instances, options.instanceId);

  const predictionMode = normalizePredictionMode(options.predictionMode ?? 'stub');
  const predictionSemantics = describePredictionMode(predictionMode);
  const memoryAblation = options.memoryAblation ?? 'B2';
  const modelName = options.modelName ?? manifest.default_model_name;
  const runId = options.runId ?? createRunId(instance.instance_id);
  const runDir = resolveRunDir(runId, options.outRoot);
  mkdirSync(runDir, { recursive: true });

  const telemetryPath = join(runDir, 'telemetry.jsonl');
  const predictionsPath = join(runDir, 'predictions.jsonl');
  const datasetManifestPath = join(runDir, 'dataset-manifest.json');
  const runMetaPath = join(runDir, 'run-meta.json');
  const summaryPath = join(runDir, 'summary.json');
  const datasetSubset = options.datasetSubset;
  const realPatch =
    options.modelPatch ??
    (options.patchFile ? readFileSync(options.patchFile, 'utf-8') : undefined);

  writeFileSync(telemetryPath, '', { flag: 'a' });
  writeJson(datasetManifestPath, {
    dataset_version: manifest.dataset_version,
    dataset_jsonl: datasetPath,
    dataset_hf_dir: manifest.dataset_hf_dir,
    subset_id: datasetSubset,
    instance_ids: [instance.instance_id],
  });

  const memorySink = new InMemoryTelemetrySink();
  const sink = new CompositeTelemetrySink([memorySink, new JsonlTelemetrySink(telemetryPath)]);

  const runMeta: EvalRunMeta = {
    run_id: runId,
    instance_id: instance.instance_id,
    repo: instance.repo,
    prediction_mode: predictionMode,
    prediction_semantics: predictionSemantics,
    memory_ablation: memoryAblation,
    model_name: modelName,
    dataset_jsonl: datasetPath,
    dataset_manifest_path: datasetManifestPath,
    started_at: new Date().toISOString(),
    scaffold_baseline: !options.skipScaffold,
  };
  if (datasetSubset) {
    runMeta.dataset_subset = datasetSubset;
  }
  writeRunMeta(runMetaPath, runMeta);

  if (!options.skipScaffold) {
    await runBasicFlow({ telemetry: sink });
  }

  const prediction = buildPrediction(instance, modelName, predictionMode, realPatch);
  writePredictionsJsonl(predictionsPath, [prediction]);

  const harnessPort = createFHarnessTelemetryPort(sink);
  let harnessReport = undefined;
  const harnessReportPath = options.harnessReportPath;

  if (harnessReportPath) {
    harnessReport = readHarnessReport(harnessReportPath);
    const instanceReport = getInstanceReport(harnessReport, instance.instance_id);
    await harnessPort.recordSweEvoEvaluation({
      instance_id: instance.instance_id,
      instance_seq: options.instanceSeq ?? 1,
      resolved: instanceReport?.resolved === true,
      applied: instanceReport?.patch_successfully_applied === true,
      p2p_regression: hasP2pRegression(instanceReport),
      memory_ablation: memoryAblation,
    });
  }

  const summaryInput = {
    runId,
    instanceIds: [instance.instance_id],
    predictionMode,
    predictionSemantics,
    memoryAblation,
    modelName,
    telemetryPath,
    predictionsPath,
    datasetManifestPath,
    telemetrySink: memorySink,
  };

  const summary = buildEvalSummary(
    harnessReport
      ? {
          ...summaryInput,
          harnessReport,
          harnessReportPath: harnessReportPath!,
        }
      : summaryInput,
  );
  writeJson(summaryPath, summary);

  return { runDir, summary, runMeta };
}

export interface RunSmokeOptions {
  runId?: string;
  predictionMode?: PredictionMode;
  memoryAblation?: MemoryAblation;
  modelName?: string;
  datasetPath?: string;
  datasetSubset?: string;
  outRoot?: string;
  skipScaffold?: boolean;
  instanceIds?: string[];
  patchFile?: string;
}

export async function runEvalSmoke(options: RunSmokeOptions = {}): Promise<RunInstanceResult[]> {
  const manifest = loadManifest();
  const subsetId = options.datasetSubset ?? manifest.default_subset ?? 'v0-smoke';
  const subset = options.instanceIds ? undefined : loadDatasetSubset(manifest, subsetId);
  const instanceIds = options.instanceIds ?? subset?.instance_ids ?? manifest.smoke_instance_ids;
  const runId = options.runId ?? `smoke_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const results: RunInstanceResult[] = [];

  for (let index = 0; index < instanceIds.length; index += 1) {
    const instanceId = instanceIds[index]!;
    const instanceOptions: RunInstanceOptions = {
      instanceId,
      runId: `${runId}__${instanceId}`,
      instanceSeq: index + 1,
      datasetSubset: subsetId,
    };
    if (options.predictionMode) {
      instanceOptions.predictionMode = options.predictionMode;
    }
    if (options.memoryAblation) {
      instanceOptions.memoryAblation = options.memoryAblation;
    }
    if (options.modelName) {
      instanceOptions.modelName = options.modelName;
    }
    if (options.datasetPath) {
      instanceOptions.datasetPath = options.datasetPath;
    }
    if (options.datasetSubset) {
      instanceOptions.datasetSubset = options.datasetSubset;
    }
    if (options.outRoot) {
      instanceOptions.outRoot = options.outRoot;
    }
    if (options.skipScaffold) {
      instanceOptions.skipScaffold = options.skipScaffold;
    }
    if (options.patchFile) {
      instanceOptions.patchFile = options.patchFile;
    }

    const result = await runEvalInstance(instanceOptions);
    results.push(result);
  }

  return results;
}
