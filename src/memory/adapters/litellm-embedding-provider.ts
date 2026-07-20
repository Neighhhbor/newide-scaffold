/**
 * LiteLLMEmbeddingProvider — 真实 Embedding 实现
 *
 * 使用 Vercel AI SDK 的 embed() 函数 + @ai-sdk/openai provider，
 * 调用 OpenAI 兼容的 embedding API（支持 OpenAI、DeepSeek、通义千问等）。
 *
 * 环境变量：
 * - OPENAI_API_KEY       — API key（必需，除非通过 options 传入）
 * - OPENAI_BASE_URL      — 自定义 base URL（兼容国内 API）
 * - EMBEDDING_MODEL      — 模型名（默认 'text-embedding-3-small'）
 * - EMBEDDING_DIMENSIONS — 维度（默认 1536，需与模型支持的维度一致）
 *
 * 用法：
 * ```ts
 * const embedding = new LiteLLMEmbeddingProvider();
 * const vector = await embedding.embed('hello world');
 * const sim = embedding.cosineSimilarity(vecA, vecB);
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, cosineSimilarity as aiCosineSimilarity } from 'ai';
import type { EmbeddingProvider } from '../ports/embedding-provider';

// ──────────────────────────────────────────────
// 环境变量加载（与 litellm-client-adapter.ts 共享相同逻辑）
// ──────────────────────────────────────────────

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

function loadLocalEnv(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(moduleDir, '..', '..', '..');
  const memoryDir = resolve(moduleDir, '..');

  loadEnvFile(resolve(projectRoot, '.env.local'));
  loadEnvFile(resolve(memoryDir, '.env'));

  if (process.env.LLM_PROVIDER === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY;
    }
    if (!process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
    }
  }
}

// ──────────────────────────────────────────────
// 默认配置
// ──────────────────────────────────────────────

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

// ──────────────────────────────────────────────
// 配置选项
// ──────────────────────────────────────────────

export interface LiteLLMEmbeddingProviderOptions {
  /** API Key 覆盖（默认从 OPENAI_API_KEY 环境变量读取） */
  apiKey?: string;
  /** Base URL 覆盖（默认从 OPENAI_BASE_URL 环境变量读取，兼容国内 API） */
  baseUrl?: string;
  /** 模型名（默认 'text-embedding-3-small'，或从 EMBEDDING_MODEL 环境变量读取） */
  model?: string;
  /** 向量维度（默认 1536，或从 EMBEDDING_DIMENSIONS 环境变量读取） */
  dimensions?: number;
  /** 是否加载环境变量（默认 true） */
  loadEnv?: boolean;
}

// ──────────────────────────────────────────────
// LiteLLMEmbeddingProvider
// ──────────────────────────────────────────────

export class LiteLLMEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly modelId: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private modelInstance: Awaited<ReturnType<typeof createEmbeddingModel>> | null = null;

  constructor(options: LiteLLMEmbeddingProviderOptions = {}) {
    // 加载环境变量
    if (options.loadEnv !== false) {
      loadLocalEnv();
    }

    // API key: option > EMBEDDING_API_KEY > OPENAI_API_KEY > DEEPSEEK_API_KEY
    this.apiKey =
      options.apiKey ??
      process.env.EMBEDDING_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.DEEPSEEK_API_KEY;

    // Base URL: option > EMBEDDING_BASE_URL（不污染全局 OPENAI_BASE_URL）
    this.baseUrl = options.baseUrl ?? process.env.EMBEDDING_BASE_URL;

    this.modelId = options.model ?? process.env.EMBEDDING_MODEL ?? DEFAULT_MODEL;
    this.dimensions =
      options.dimensions ??
      (process.env.EMBEDDING_DIMENSIONS
        ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
        : undefined) ??
      DEFAULT_DIMENSIONS;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.modelInstance) {
      this.modelInstance = await createEmbeddingModel(this.modelId, this.apiKey, this.baseUrl);
    }

    const result = await embed({
      model: this.modelInstance,
      value: text,
    });

    return result.embedding as number[];
  }

  cosineSimilarity(a: number[], b: number[]): number {
    // 使用 AI SDK 内置的 cosineSimilarity（已在 ai 包中导出）
    // 需要处理维度不匹配的情况：pad 或 truncate 到 this.dimensions
    const left = padOrTruncate(a, this.dimensions);
    const right = padOrTruncate(b, this.dimensions);
    return aiCosineSimilarity(left, right);
  }
}

// ──────────────────────────────────────────────
// 内部辅助
// ──────────────────────────────────────────────

/**
 * 创建 embedding model 实例。
 * 使用 @ai-sdk/openai 的 openai.embedding() —— 支持任何 OpenAI 兼容 endpoint。
 * apiKey / baseURL 直接传入 provider 构造函数，不污染 process.env。
 */
async function createEmbeddingModel(modelId: string, apiKey?: string, baseURL?: string) {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const provider = createOpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
  });
  return provider.embedding(modelId);
}

function padOrTruncate(vector: number[], dimensions: number): number[] {
  if (vector.length === dimensions) {
    return vector;
  }
  if (vector.length > dimensions) {
    return vector.slice(0, dimensions);
  }
  return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)];
}
