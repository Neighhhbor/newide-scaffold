import {
  createProductionBackendService,
  startBackendRpcServer,
} from '../../src/app/backend-rpc-stdio';
import type { ToolCallingClient } from '../../src/memory';

const service = createProductionBackendService(process.env, {
  agentLlm: deterministicInvokeDriverLlm(),
});

startBackendRpcServer({
  input: process.stdin,
  writeLine: (line) => process.stdout.write(`${line}\n`),
  service,
  logError: (message) => process.stderr.write(`${message}\n`),
});

function deterministicInvokeDriverLlm(): ToolCallingClient {
  let sequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }

      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      sequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `task_rpc_tool_call_${String(sequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: userMessage?.content?.replace(/^Task:\s*/, '') ?? 'Execute task.',
              }),
            },
          },
        ],
      };
    },
  };
}
