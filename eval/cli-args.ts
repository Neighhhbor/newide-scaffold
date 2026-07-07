import {
  runEvalInstance,
  runEvalSmoke,
  type RunInstanceOptions,
  type RunSmokeOptions,
} from './run-instance-core';
import type { MemoryAblation, PredictionMode } from './types';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

export function buildRunInstanceOptions(args: {
  instanceId: string;
  mode: PredictionMode;
  ablation: MemoryAblation;
  runId?: string;
  modelName?: string;
  datasetPath?: string;
  datasetSubset?: string;
  outRoot?: string;
  harnessReportPath?: string;
  patchFile?: string;
  skipScaffold: boolean;
}): RunInstanceOptions {
  const options: RunInstanceOptions = {
    instanceId: args.instanceId,
    predictionMode: args.mode,
    memoryAblation: args.ablation,
  };

  if (args.runId) {
    options.runId = args.runId;
  }
  if (args.modelName) {
    options.modelName = args.modelName;
  }
  if (args.datasetPath) {
    options.datasetPath = args.datasetPath;
  }
  if (args.datasetSubset) {
    options.datasetSubset = args.datasetSubset;
  }
  if (args.outRoot) {
    options.outRoot = args.outRoot;
  }
  if (args.harnessReportPath) {
    options.harnessReportPath = args.harnessReportPath;
  }
  if (args.patchFile) {
    options.patchFile = args.patchFile;
  }
  if (args.skipScaffold) {
    options.skipScaffold = true;
  }

  return options;
}

export function buildRunSmokeOptions(args: {
  mode: PredictionMode;
  ablation: MemoryAblation;
  runId?: string;
  modelName?: string;
  datasetPath?: string;
  datasetSubset?: string;
  outRoot?: string;
  patchFile?: string;
  skipScaffold: boolean;
}): RunSmokeOptions {
  const options: RunSmokeOptions = {
    predictionMode: args.mode,
    memoryAblation: args.ablation,
  };

  if (args.runId) {
    options.runId = args.runId;
  }
  if (args.modelName) {
    options.modelName = args.modelName;
  }
  if (args.datasetPath) {
    options.datasetPath = args.datasetPath;
  }
  if (args.datasetSubset) {
    options.datasetSubset = args.datasetSubset;
  }
  if (args.outRoot) {
    options.outRoot = args.outRoot;
  }
  if (args.patchFile) {
    options.patchFile = args.patchFile;
  }
  if (args.skipScaffold) {
    options.skipScaffold = true;
  }

  return options;
}

export { readFlag, hasFlag, runEvalInstance, runEvalSmoke };
