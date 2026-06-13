import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from "../core";
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle
} from "./contract";

export class MockDriver implements DriverRuntimeHandle {
  readonly driver_id = "mock-driver";
  readonly session_id = "mock-session";
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: true,
    supports_permission_events: false
  };

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    const created_at = nowTimestamp();
    const patchArtifact: ArtifactRef = {
      artifact_id: createId("artifact"),
      type: "patch",
      uri: `artifact://patch/${input.task_id}/mock-driver.patch`,
      sha256: "mock-sha256",
      producer_id: this.driver_id,
      task_id: input.task_id,
      metadata: {
        prompt_length: input.prompt.length,
        context_pack_id: input.context_pack_ref?.context_pack_id
      },
      created_at,
      schema_version: SCHEMA_VERSION
    };
    const transcript = await this.collectTranscript(input.task_id);

    return {
      driver_run_result_id: createId("driver_result"),
      session_id: this.session_id,
      status: "succeeded",
      artifacts: [patchArtifact],
      transcript_ref: transcript,
      tool_events: [
        {
          tool_event_id: createId("tool_event"),
          tool_name: "mock.write_patch",
          status: "completed",
          summary: "MockDriver produced a deterministic patch artifact.",
          created_at,
          schema_version: SCHEMA_VERSION
        }
      ],
      diagnostics: {
        driver_id: this.driver_id,
        duration_ms: 1,
        notes: ["Mock implementation; no real ACP or PTY session was started."]
      },
      created_at,
      schema_version: SCHEMA_VERSION
    };
  }

  async interrupt(_reason: string): Promise<void> {
    return Promise.resolve();
  }

  async collectTranscript(taskId = "task"): Promise<ArtifactRef> {
    const created_at = nowTimestamp();
    return {
      artifact_id: createId("artifact"),
      type: "transcript",
      uri: `artifact://transcript/${taskId}/mock-session`,
      producer_id: this.driver_id,
      task_id: taskId,
      created_at,
      schema_version: SCHEMA_VERSION
    };
  }
}
