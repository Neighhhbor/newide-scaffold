import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { DriverPrompt, DriverRunResult } from './contract';
import { assertDriverRunResult, type ExternalDriverTransport } from './external-driver-runtime';

export interface CommandDriverTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  unsetEnv?: readonly string[];
  timeoutMs?: number;
  /**
   * 是否通过 shell 执行命令。
   * 默认：Windows 上为 true（需要 shell 才能找到 pnpm.cmd / npx.cmd），
   * 其他平台为 false。
   */
  shell?: boolean;
}

export class CommandDriverTransport implements ExternalDriverTransport {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly unsetEnv: readonly string[];
  private readonly timeoutMs: number | undefined;
  private readonly shell: boolean;
  private stderr = '';

  constructor(options: CommandDriverTransportOptions) {
    if (!options.command.trim()) {
      throw new Error('Command driver command is required');
    }
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new Error('Command driver timeoutMs must be greater than 0');
    }

    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.unsetEnv = options.unsetEnv ?? [];
    // 默认 120 秒超时，避免外部 Driver 无限期挂起
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.shell = options.shell ?? process.platform === 'win32';
  }

  get lastStderr(): string {
    return this.stderr;
  }

  async invoke(input: DriverPrompt): Promise<DriverRunResult> {
    return this.run(input);
  }

  async run(input: DriverPrompt): Promise<DriverRunResult> {
    const stdout = await this.execute(input);
    let parsed: unknown;

    try {
      parsed = JSON.parse(stdout);
    } catch {
      // 容错：stdout 可能被非 JSON 文本污染（例如 auth 模块的 console.log 输出），
      // 尝试从混合输出中提取最后一个合法 JSON 对象（contract-runner 总是在最后写入 JSON）。
      const extracted = extractLastJsonObject(stdout);
      if (extracted !== null) {
        try {
          parsed = JSON.parse(extracted);
        } catch (innerError: unknown) {
          const reason = innerError instanceof Error ? innerError.message : String(innerError);
          throw new Error(
            `Command driver stdout was not valid JSON (extraction also failed): ${reason}. stdout: ${summarizeText(stdout)}`,
          );
        }
      } else {
        throw new Error(
          `Command driver stdout was not valid JSON and no JSON object could be extracted. stdout: ${summarizeText(stdout)}`,
        );
      }
    }

    assertDriverRunResult(parsed, 'Command driver');
    return parsed;
  }

  private execute(input: DriverPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdinError: Error | undefined;
      let timedOut = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;

      const child = spawn(this.command, this.args, this.spawnOptions());

      const clearTimers = (): void => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
      };

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        reject(error);
      };

      if (this.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          terminateChild(child.pid, 'SIGTERM');
          forceKillTimeout = setTimeout(() => {
            terminateChild(child.pid, 'SIGKILL');
          }, 1_000);
        }, this.timeoutMs);
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.stdin.on('error', (error: Error) => {
        stdinError = error;
      });

      child.once('error', (error: Error) => {
        rejectOnce(
          new Error(`Command driver failed to start ${this.commandLabel()}: ${error.message}`),
        );
      });

      child.once('close', (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        this.stderr = Buffer.concat(stderrChunks).toString('utf8');
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrSummary = summarizeText(this.stderr);

        if (timedOut) {
          reject(
            new Error(
              `Command driver timed out after ${String(this.timeoutMs)}ms: ${this.commandLabel()}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        if ((code !== 0 || signal) && stdoutIsDriverRunResult(stdout)) {
          resolve(stdout);
          return;
        }

        if (code !== 0) {
          reject(
            new Error(
              `Command driver failed: ${this.commandLabel()} exited with code ${String(code)}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        if (signal) {
          reject(
            new Error(
              `Command driver failed: ${this.commandLabel()} exited with signal ${signal}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        if (stdinError) {
          reject(
            new Error(
              `Command driver failed to write DriverPrompt to stdin: ${stdinError.message}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        resolve(stdout);
      });

      const stdinPayload = JSON.stringify(input);
      child.stdin.end(stdinPayload);
    });
  }

  private spawnOptions(): SpawnOptionsWithoutStdio {
    const options: SpawnOptionsWithoutStdio = {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.shell,
    };

    if (this.timeoutMs !== undefined && process.platform !== 'win32') {
      options.detached = true;
    }

    if (this.cwd !== undefined) {
      options.cwd = this.cwd;
    }

    if (this.env !== undefined || this.unsetEnv.length > 0) {
      const env = {
        ...process.env,
        ...(this.env ?? {}),
      };
      for (const key of this.unsetEnv) {
        delete env[key];
      }
      options.env = env;
    }

    return options;
  }

  private commandLabel(): string {
    return [
      this.command,
      ...this.args.map((arg) => summarizeText(arg.replace(/\s+/g, ' '), 80)),
    ].join(' ');
  }
}

/**
 * 从混合 stdout 中提取最后一个合法的 JSON 对象。
 *
 * 当子进程通过 console.log() 在 stdout 上输出非 JSON 文本时
 * （例如 auth 模块打印的登录横幅），stdout 会变成"文本前缀 + JSON"的混合体。
 * 此函数从 stdout 末尾向前搜索 `{`，用花括号深度计数的方式提取完整 JSON。
 */
function extractLastJsonObject(text: string): string | null {
  // 策略：从最后一个 `{` 开始尝试提取 JSON 对象。
  // contract-runner 总是在 stdout 最后一行写入 DriverRunResult JSON，
  // 所以在混合输出的场景下，最后一个 `{` 就是 JSON 的起点。
  const lastBrace = text.lastIndexOf('{');
  if (lastBrace === -1) return null;

  return extractJsonFrom(text, lastBrace);
}

/**
 * 从指定位置开始，用花括号深度计数提取一个完整的 JSON 值（对象或数组）。
 * 支持字符串内的转义和嵌套。
 */
function extractJsonFrom(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null; // 未闭合
}

function summarizeText(input: string, maxLength = 500): string {
  const text = input.trim();
  if (!text) {
    return '<empty>';
  }
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function stdoutIsDriverRunResult(stdout: string): boolean {
  if (!stdout.trim()) {
    return false;
  }

  try {
    assertDriverRunResult(JSON.parse(stdout), 'Command driver');
    return true;
  } catch {
    return false;
  }
}

function terminateChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // The process may have already exited.
  }
}
