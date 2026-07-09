/**
 * ================================================
 * Request Pool
 * ================================================
 * HTTP connection pooling and request lifecycle.
 * Wraps fetch with keep-alive, timeout, and retry logic.
 */

import type { RequestPoolConfig } from './types';

const DEFAULT_POOL_CONFIG: RequestPoolConfig = {
  maxConnections: 50,
  keepAliveTimeout: 30000,
  maxRequestsPerConnection: 1000,
  requestTimeout: 30000,
};

/** Retryable HTTP status codes */
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

/** Network errors that warrant retry */
const RETRYABLE_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE'];

export interface RequestResult {
  response: Response;
  attempts: number;
  durationMs: number;
}

export class RequestPool {
  private readonly fetchImpl: typeof fetch;
  private readonly config: RequestPoolConfig;

  constructor(fetchImpl?: typeof fetch, config: Partial<RequestPoolConfig> = {}) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  /**
   * Execute an HTTP POST request with retry logic.
   * Automatically handles timeouts and transient failures.
   */
  async post(
    url: string,
    body: Record<string, unknown>,
    apiKey: string,
    options: {
      timeoutMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<RequestResult> {
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeout;
    const maxRetries = options.maxRetries ?? 3;
    const retryDelayMs = options.retryDelayMs ?? 1000;

    const startTime = Date.now();

    // Total attempts = 1 + maxRetries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Merge external signal
        if (options.signal) {
          const onAbort = () => controller.abort();
          options.signal.addEventListener('abort', onAbort);
          if (options.signal.aborted) {
            controller.abort();
          }
        }

        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          keepalive: true,
        });

        clearTimeout(timeoutId);

        // Retry on transient HTTP errors (if we have retries left)
        if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
          const delay = retryDelayMs * (attempt + 1);
          await sleep(delay);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new HttpError(response.status, errorText, url);
        }

        return {
          response,
          attempts: attempt + 1,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const isRetryable = isRetryableError(error);

        if (isLastAttempt || !isRetryable) {
          throw error;
        }

        const delay = retryDelayMs * (attempt + 1);
        await sleep(delay);
      }
    }

    throw new Error('Max retries exceeded');
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  if (error instanceof HttpError) return RETRYABLE_STATUS.has(error.status);
  return RETRYABLE_ERRORS.some((code) => error.message?.includes(code));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Structured HTTP error */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`HTTP ${status} at ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}
