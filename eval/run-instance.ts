#!/usr/bin/env node
import { buildRunInstanceOptions, hasFlag, readFlag, runEvalInstance } from './cli-args';
import { parseMemoryAblation, parsePredictionMode } from './validation';

async function main(): Promise<void> {
  const instanceId = readFlag('--instance-id');
  if (!instanceId) {
    console.error(
      'Usage: pnpm eval:instance -- --instance-id <id> [--mode stub|oracle|real] [--patch-file <path>] [--ablation B0|B1|B2|B3] [--subset <id>] [--run-id <id>] [--skip-scaffold] [--harness-report <path>]',
    );
    process.exitCode = 1;
    return;
  }

  const mode = parsePredictionMode(readFlag('--mode'));
  const ablation = parseMemoryAblation(readFlag('--ablation'));

  const result = await runEvalInstance(
    buildRunInstanceOptions({
      instanceId,
      mode,
      ablation,
      skipScaffold: hasFlag('--skip-scaffold'),
      ...(readFlag('--run-id') ? { runId: readFlag('--run-id')! } : {}),
      ...(readFlag('--model') ? { modelName: readFlag('--model')! } : {}),
      ...(readFlag('--dataset') ? { datasetPath: readFlag('--dataset')! } : {}),
      ...(readFlag('--subset') ? { datasetSubset: readFlag('--subset')! } : {}),
      ...(readFlag('--out-root') ? { outRoot: readFlag('--out-root')! } : {}),
      ...(readFlag('--harness-report') ? { harnessReportPath: readFlag('--harness-report')! } : {}),
      ...(readFlag('--patch-file') ? { patchFile: readFlag('--patch-file')! } : {}),
    }),
  );

  console.log(`[F-Eval] run_dir=${result.runDir}`);
  console.log(`[F-Eval] telemetry=${result.summary.telemetry_path}`);
  console.log(`[F-Eval] predictions=${result.summary.predictions_path}`);
  console.log(`[F-Eval] summary=${result.runDir}/summary.json`);
  console.log(`[F-Eval] telemetry_events=${result.summary.telemetry_event_types.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
