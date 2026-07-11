/**
 * LiteLLMClientAdapter — 将 LiteLLMClient 适配为 LlmClient 接口
 *
 * 自动加载项目根目录的 .env.local（已 gitignore），将其中定义的
 * 环境变量注入 process.env，供 AI SDK provider（如 @ai-sdk/openai）使用。
 *
 * 使用方式：
 *   1. 在项目根目录创建 .env.local：
 *      OPENAI_API_KEY=sk-xxx
 *      OPENAI_BASE_URL=https://api.deepseek.com/v1
 *   2. 一行命令跑测试：
 *      npx vitest run src/memory/test
 *
 * 替换 DeepSeekLlmClient 后，API key 不再通过构造函数传入，
 * 而是由 AI SDK provider 通过环境变量管理。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiteLLMClient } from '../../litellm';
import type { LiteLLMMessage } from '../../litellm';
import type { LlmClient, LlmMessage } from '../ports/llm-client';

/**
 * 从文件中逐行加载 key=value 到 process.env
 * 不覆盖已存在的环境变量（shell 优先级更高）
 */
function loadEnvFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // 文件不存在 → 跳过
  }
}

/** 加载环境变量，支持 .env.local（项目根目录）和 memory/.env */
function loadLocalEnv(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(moduleDir, '..', '..', '..');
  const memoryDir = resolve(moduleDir, '..'); // src/memory/

  // 1. 先加载项目根目录的 .env.local（最高优先级）
  loadEnvFile(resolve(projectRoot, '.env.local'));
  // 2. 再加载 src/memory/.env
  loadEnvFile(resolve(memoryDir, '.env'));

  // 3. 如果配置了 LLM_PROVIDER=deepseek，自动映射到 AI SDK 所需的 env var
  if (process.env.LLM_PROVIDER === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY;
    }
    if (!process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
    }
  }
}

export class LiteLLMClientAdapter implements LlmClient {
  private client: LiteLLMClient;
  private readonly taskName: string;

  constructor(taskName: string = 'memory-query') {
    loadLocalEnv();
    this.client = new LiteLLMClient();
    // @ai-sdk/openai v4 默认走 Responses API（/v1/responses），
    // DeepSeek 只支持 Chat Completions API（/v1/chat/completions），
    // 注册 custom provider 使用 .chat() 以兼容 DeepSeek
    // @ai-sdk/openai 的 registerProvider 是异步的
    this.client.registerProvider('openai', async (modelId: string) => {
      const { openai } = await import('@ai-sdk/openai');
      // 使用 .chat() 走 Chat Completions API，兼容 DeepSeek
      return openai.chat(modelId);
    });
    this.client.loadConfig();
    this.taskName = taskName;
  }

  async complete(input: {
    messages: LlmMessage[];
    responseFormat?: { type: 'json_object' };
  }): Promise<string> {
    // DeepSeek (通过 @ai-sdk/openai) 不支持 messages 中的 system role，
    // 将 system 消息内容合并到第一条 user 消息前
    const systemParts: string[] = [];
    const nonSystem = input.messages.filter((m) => {
      if (m.role === 'system') {
        systemParts.push(m.content);
        return false;
      }
      return true;
    });
    const merged: LiteLLMMessage[] =
      systemParts.length > 0
        ? ([
            {
              role: 'user',
              content: systemParts.join('\n\n') + '\n\n---\n\n' + (nonSystem[0]?.content ?? ''),
            },
            ...nonSystem.slice(1),
          ] as LiteLLMMessage[])
        : (nonSystem as LiteLLMMessage[]);

    const response = await this.client.complete({
      task: this.taskName,
      messages: merged,
      responseFormat: input.responseFormat
        ? { name: 'response', schema: { type: 'object' }, strict: true }
        : undefined,
    });
    return response.content;
  }
}
