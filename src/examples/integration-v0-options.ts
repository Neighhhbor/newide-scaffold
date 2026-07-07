/**
 * integration-v0 示例命令的参数解析。
 *
 * 这里只负责 CLI 字符串到运行选项的转换，不创建 driver / council provider。
 */
export type IntegrationV0CouncilProviderMode = 'mock' | 'synthesis-agent';

export interface IntegrationV0CliOptions {
  enableCouncil: boolean;
  useExternalDriver: boolean;
  councilProviderMode: IntegrationV0CouncilProviderMode;
  driverPrompt: string;
}

const DEFAULT_PROMPT = 'Produce a mock patch artifact for integration v0 test';

export function parseIntegrationV0CliArgs(args: string[]): IntegrationV0CliOptions {
  const parsed = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    if (arg.includes('=')) {
      const [key, value] = arg.split('=', 2);
      parsed.set(key!, value ?? true);
      continue;
    }

    if (arg === '--council-provider') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--council-provider requires a value');
      }
      parsed.set(arg, value);
      index += 1;
      continue;
    }

    parsed.set(arg, true);
  }

  const councilProviderMode = readCouncilProviderMode(parsed.get('--council-provider'));
  return {
    enableCouncil: Boolean(parsed.get('--enable-council')) || councilProviderMode !== 'mock',
    useExternalDriver: Boolean(parsed.get('--external-driver')),
    councilProviderMode,
    driverPrompt: positional[0] ?? DEFAULT_PROMPT,
  };
}

function readCouncilProviderMode(
  value: string | boolean | undefined,
): IntegrationV0CouncilProviderMode {
  if (value === undefined || value === false) {
    return 'mock';
  }
  if (value === 'mock' || value === 'synthesis-agent') {
    return value;
  }
  throw new Error(`Unsupported council provider: ${String(value)}`);
}
