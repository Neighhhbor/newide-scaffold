import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { DriverPrompt, DriverRunResult } from './contract';
import { assertDriverRunResult, type ExternalDriverTransport } from './external-driver-runtime';

export interface CommandDriverTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  unsetEnv?: readonly string[];
  timeoutMs?: number;
}

export class CommandDriverTransport implements ExternalDriverTransport {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly unsetEnv: readonly string[];
  private readonly timeoutMs: number | undefined;
  private readonly activeChildren = new Map<string, ChildProcess>();
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
    this.timeoutMs = options.timeoutMs;
  }

  get lastStderr(): string {
    return this.stderr;
  }

  async invoke(input: DriverPrompt): Promise<DriverRunResult> {
    return this.run(input);
  }

  async run(input: DriverPrompt): Promise<DriverRunResult> {
    const stdout = await this.execute(input);
    return parseDriverRunResult(stdout);
  }

  async interrupt(_reason: string, runId?: string): Promise<void> {
    const children = runId
      ? [...(this.activeChildren.get(runId) ? [this.activeChildren.get(runId)!] : [])]
      : [...this.activeChildren.values()];
    await Promise.all(children.map((child) => terminateAndWait(child)));
  }

  async shutdown(): Promise<void> {
    await this.interrupt('Command driver transport shutdown');
  }

  private execute(input: DriverPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.activeChildren.has(input.run_id)) {
        reject(new Error(`Command driver run ${input.run_id} is already active`));
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdinError: Error | undefined;
      let timedOut = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;

      const child = spawn(this.command, this.args, this.spawnOptions());
      this.activeChildren.set(input.run_id, child);

      const releaseChild = (): void => {
        if (this.activeChildren.get(input.run_id) === child) {
          this.activeChildren.delete(input.run_id);
        }
      };

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
        releaseChild();
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
        releaseChild();
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

        if (signal) {
          reject(
            new Error(
              `Command driver failed: ${this.commandLabel()} exited with signal ${signal}. stderr: ${stderrSummary}`,
            ),
          );
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

      child.stdin.end(JSON.stringify(input));
    });
  }

  private spawnOptions(): SpawnOptionsWithoutStdio {
    const options: SpawnOptionsWithoutStdio = {
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    if (process.platform !== 'win32') {
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

function terminateAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const forceKill = setTimeout(() => terminateChild(child.pid, 'SIGKILL'), 1_000);
    const giveUp = setTimeout(finish, 2_000);
    forceKill.unref();
    giveUp.unref();

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      clearTimeout(giveUp);
      child.removeListener('close', finish);
      resolve();
    }

    child.once('close', finish);
    terminateChild(child.pid, 'SIGTERM');
  });
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
    parseDriverRunResult(stdout);
    return true;
  } catch {
    return false;
  }
}

function parseDriverRunResult(stdout: string): DriverRunResult {
  const json = stdout.trim().split(/\r?\n/).at(-1) ?? '';
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Command driver stdout was not valid JSON: ${reason}. stdout: ${summarizeText(stdout)}`,
    );
  }

  assertDriverRunResult(parsed, 'Command driver');
  return parsed;
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
