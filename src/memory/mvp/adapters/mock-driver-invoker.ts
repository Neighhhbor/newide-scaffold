/**
 * Mock Driver 调用器
 *
 * 不依赖 Direction A 模块，根据 AgentTaskRequest 与检索结果生成 DriverReturn（6 字段报告）。
 */
import type { DriverReturn } from "../../schemas";
import type { AgentTaskRequest } from "../../agent-types";
import type { MemoryRetrievalResult } from "../../services/memory-query";

export interface MockDriverInvokeInput {
  task: AgentTaskRequest;
  task_id: string;
  call_id: string;
  source_driver: string;
  retrieval: MemoryRetrievalResult;
}

/** 唤起 mock Driver 并返回 Spec 6 字段报告 */
export async function invokeMockDriver(input: MockDriverInvokeInput): Promise<DriverReturn> {
  const { task, task_id, retrieval } = input;

  // pass: 真实 Driver / ACP 会话未接入
  return {
    artifacts: [
      {
        type: "patch",
        path: `artifact://patch/${task_id}/mock.patch`,
        summary: `Mock patch for: ${task.spec}`,
      },
    ],
    summary: `Mock driver completed "${task.spec}" using ${retrieval.context_pack.memory_refs.length} memory refs.`,
    decisions: [
      {
        point: "context usage",
        options: ["use-retrieved-memory", "ignore-memory"],
        chosen: "use-retrieved-memory",
        reason: "MVP always chooses retrieved mock memory",
      },
    ],
    blockers: [],
    referenced_experiences: retrieval.experiences.slice(0, 1).map((exp) => ({
      experience_id: exp.id,
      applied: true,
      effectiveness: "fully_effective" as const,
      note: "MVP mock reference",
    })),
    assumptions: [
      {
        assumption: retrieval.context_pack.summary,
        risk_if_wrong: "Mock retrieval may not reflect production memory quality",
      },
    ],
  };
}
