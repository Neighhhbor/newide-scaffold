/**
 * DeepSeekToolCallingClient — 支持 tool-calling 的 DeepSeek API 客户端
 *
 * 实现 ToolCallingClient 接口，通过 OpenAI 兼容接口调用 DeepSeek 模型
 * 的 function/tool calling 能力。
 *
 * API Key 优先级：构造参数 > DEEPSEEK_API_KEY 环境变量
 */
import type { ToolCallingClient, ToolCallMessage, ToolCallResult, ToolCall } from '../runtime/tool';
import type { ToolDefinition } from '../runtime/tool';

export interface DeepSeekToolCallingClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** OpenAI 兼容的 ChatCompletion 请求体中的消息格式 */
interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

/** OpenAI 兼容的 ChatCompletion 响应体 */
interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class DeepSeekToolCallingClient implements ToolCallingClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: DeepSeekToolCallingClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.model = options.model ?? 'deepseek-chat';
    this.baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');

    if (!this.apiKey) {
      throw new Error(
        'DeepSeekToolCallingClient: DEEPSEEK_API_KEY is required. ' +
          'Pass it in constructor options or set the DEEPSEEK_API_KEY environment variable.',
      );
    }
  }

  async completeWithTools(input: {
    messages: ToolCallMessage[];
    tools: ToolDefinition[];
    tool_choice?: 'auto' | 'none';
  }): Promise<ToolCallResult> {
    const openAIMessages = this.toOpenAIMessages(input.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: openAIMessages,
      tools: input.tools,
      tool_choice: input.tool_choice ?? 'auto',
    };

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

    const json = (await response.json()) as OpenAIResponse;

    const message = json.choices?.[0]?.message;
    if (!message) {
      throw new Error('DeepSeek API returned empty response');
    }

    // 解析 tool_calls（如果有）
    let tool_calls: ToolCall[] | undefined;
    if (message.tool_calls && message.tool_calls.length > 0) {
      tool_calls = message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    return {
      content: message.content ?? null,
      tool_calls,
    };
  }

  /**
   * 将 ToolCallMessage[] 转换为 OpenAI 兼容的消息格式。
   * ToolCallMessage 的字段设计已与 OpenAI 格式对齐，直接映射即可。
   */
  private toOpenAIMessages(messages: ToolCallMessage[]): OpenAIMessage[] {
    return messages.map((msg) => {
      const base: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        base.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }

      if (msg.tool_call_id) {
        base.tool_call_id = msg.tool_call_id;
      }

      return base;
    });
  }
}
