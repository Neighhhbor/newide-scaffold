/**
 * DeepSeekLlmClient — LlmClient 的 DeepSeek API 实现
 *
 * 通过 OpenAI 兼容接口调用 DeepSeek 模型（deepseek-chat / deepseek-reasoner）。
 * 不支持 streaming，纯 complete 调用。
 *
 * API Key 优先级：构造参数 > DEEPSEEK_API_KEY 环境变量
 */
import type { LlmClient, LlmMessage } from '../ports/llm-client';

export interface DeepSeekLlmClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class DeepSeekLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: DeepSeekLlmClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.model = options.model ?? 'deepseek-chat';
    this.baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');

    if (!this.apiKey) {
      throw new Error(
        'DeepSeekLlmClient: DEEPSEEK_API_KEY is required. ' +
          'Pass it in constructor options or set the DEEPSEEK_API_KEY environment variable.',
      );
    }
  }

  async complete(input: {
    messages: LlmMessage[];
    responseFormat?: { type: 'json_object' };
  }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: input.messages,
    };

    // deepseek-chat (V3) 支持 JSON mode；deepseek-reasoner (R1) 不支持
    if (input.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new Error('DeepSeek API returned empty response');
    }

    return content;
  }
}
