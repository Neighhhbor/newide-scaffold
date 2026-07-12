import type { DriverPrompt, DriverRunResult, DriverRuntimeHandle } from './contract';

export async function runDriverPromptWithSignal(
  driver: DriverRuntimeHandle,
  input: DriverPrompt,
  signal?: AbortSignal,
): Promise<DriverRunResult> {
  if (!signal) return driver.sendPrompt(input);
  if (signal.aborted) {
    const reason = abortReason(signal);
    await driver.interrupt(reason.message);
    throw reason;
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason = abortReason(signal);
      void driver.interrupt(reason.message).then(
        () => reject(reason),
        (error: unknown) => reject(error),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([driver.sendPrompt(input), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? 'Run cancelled'));
}
