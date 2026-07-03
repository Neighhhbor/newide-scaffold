/**
 * MockLlmClient — LlmClient 的 mock 实现
 *
 * 支持场景匹配响应和抛错，供 LlmExperienceExtractor 等组件的测试使用。
 *
 * 匹配规则：
 *   - 传入空 responses 数组 → 所有调用抛错（模拟 LLM 不可用）
 *   - 传入 { match: /pattern/, response: "..." } → 消息内容匹配时返回预设响应
 *   - 传入 { response: "..." }（无 match）→ 兜底响应
 *   - 优先级：精确 match > 兜底 > 抛错
 */
import type { LlmClient, LlmMessage } from '../ports/llm-client';

export interface MockLlmResponse {
  /** 可选的正则匹配模式，匹配第一条 user 消息的内容 */
  match?: RegExp;
  /** 预设响应文本。以 "ERROR:" 开头时模拟 LLM 调用失败 */
  response: string;
}

export class MockLlmClient implements LlmClient {
  private callIndex = 0;

  constructor(private readonly responses: MockLlmResponse[]) {}

  async complete(input: {
    messages: LlmMessage[];
    responseFormat?: { type: 'json_object' };
  }): Promise<string> {
    const userMessage = input.messages.find((m) => m.role === 'user')?.content ?? '';
    const index = this.callIndex++;
    const response = this.responses[index] ?? this.matchFirst(userMessage);

    if (!response || response.response.startsWith('ERROR:')) {
      throw new Error(
        response
          ? response.response.slice(6)
          : `MockLlmClient: no response configured for call #${index}`,
      );
    }

    return response.response;
  }

  /** 重置调用计数器（每个测试用例开始前调用） */
  reset(): void {
    this.callIndex = 0;
  }

  private matchFirst(content: string): MockLlmResponse | undefined {
    for (const r of this.responses) {
      if (r.match && r.match.test(content)) {
        return r;
      }
    }
    return this.responses.find((r) => !r.match);
  }
}
