import {
  buildAgentCrashTelemetry,
  buildColdRestartTelemetry,
  buildCooperBenchEvaluationTelemetry,
  buildProxyUsageTelemetry,
  buildSweEvoEvaluationTelemetry,
  type AgentCrashTelemetryInput,
  type ColdRestartTelemetryInput,
  type CooperBenchEvaluationTelemetryInput,
  type ProxyUsageTelemetryInput,
  type SweEvoEvaluationTelemetryInput,
} from './event-builders';
import { emitTelemetry, type TelemetryRecord, type TelemetrySink } from './telemetry-sink';

/**
 * F 方向 Harness 写入 TelemetrySink 的统一入口。
 * L1 信号不进 EventStore，由外部评测框架调用后自行落盘或转发。
 */
export class FHarnessTelemetryPort {
  constructor(private readonly sink: TelemetrySink) {}

  get telemetrySink(): TelemetrySink {
    return this.sink;
  }

  recordSweEvoEvaluation(input: SweEvoEvaluationTelemetryInput): Promise<TelemetryRecord> {
    return emitTelemetry(this.sink, buildSweEvoEvaluationTelemetry(input));
  }

  recordCooperBenchEvaluation(
    input: CooperBenchEvaluationTelemetryInput,
  ): Promise<TelemetryRecord> {
    return emitTelemetry(this.sink, buildCooperBenchEvaluationTelemetry(input));
  }

  recordProxyUsage(input: ProxyUsageTelemetryInput): Promise<TelemetryRecord> {
    return emitTelemetry(this.sink, buildProxyUsageTelemetry(input));
  }

  recordAgentCrash(input: AgentCrashTelemetryInput): Promise<TelemetryRecord> {
    return emitTelemetry(this.sink, buildAgentCrashTelemetry(input));
  }

  recordColdRestart(input: ColdRestartTelemetryInput): Promise<TelemetryRecord> {
    return emitTelemetry(this.sink, buildColdRestartTelemetry(input));
  }
}

export function createFHarnessTelemetryPort(sink: TelemetrySink): FHarnessTelemetryPort {
  return new FHarnessTelemetryPort(sink);
}
