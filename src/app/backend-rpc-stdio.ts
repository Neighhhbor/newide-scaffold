/**
 * NewIDE 后端 JSON-RPC stdio 入口。
 *
 * 这个文件只管理进程流和连接生命周期，业务方法由 NewideBackendService 提供。
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../rpc/json-rpc-dispatcher';
import { RunRpcMethods } from '../rpc/run-methods';
import { NewideBackendService } from './newide-backend-service';

export interface BackendRpcServerOptions {
  input: Readable;
  writeLine: (line: string) => void;
  service?: NewideBackendService;
  logError?: (message: string) => void;
}

export interface BackendRpcServer {
  close(): void;
}

export function startBackendRpcServer(options: BackendRpcServerOptions): BackendRpcServer {
  const dispatcher = new JsonRpcDispatcher();
  const session = new JsonRpcLineSession(dispatcher, options.writeLine);
  const methods = new RunRpcMethods(
    options.service ?? new NewideBackendService(),
    (method, params) => session.sendNotification(method, params),
  );
  methods.register(dispatcher);

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    pending = pending
      .then(() => session.handleLine(line))
      .catch((error: unknown) => options.logError?.(String(error)));
  });
  lines.on('close', () => methods.dispose());

  return {
    close: () => {
      methods.dispose();
      lines.close();
    },
  };
}

function runMain(): void {
  const server = startBackendRpcServer({
    input: process.stdin,
    writeLine: (line) => process.stdout.write(`${line}\n`),
    logError: (message) => process.stderr.write(`${message}\n`),
  });
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain();
}
