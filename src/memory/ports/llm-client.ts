/**
 * LlmClient 端口
 *
 * memory 模块对 LLM 调用的最小抽象。不绑定任何 provider SDK，
 * 供 ExperienceExtractor、TaskInstructionPlanner 等 LLM 依赖组件使用。
 *
 * 实现类由 adapter 提供（mock-llm-client.ts 为测试用 mock；
 * 真实 adapter 放在 core/或其他模块，实现此接口即可注入）。
 */
export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmClient {
  /**
   * 发送消息列表给 LLM，返回完整响应文本。
   * @param input.messages  - 消息列表（system + user）
   * @param input.responseFormat - 可选，指定输出格式（如 json_object）
   */
  complete(input: {
    messages: LlmMessage[];
    responseFormat?: { type: 'json_object' };
  }): Promise<string>;
}
