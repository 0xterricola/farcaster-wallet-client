// Only retry missing-block errors. A successful low allowance, contract revert,
// or unrelated RPC failure must not be mistaken for a lagging block.
function isMissingBlock(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const details = current as {
      message?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    if (
      [details.message, details.details].some(
        (value) =>
          typeof value === 'string' &&
          /block not found|unknown block|header not found|block is out of range/i.test(
            value,
          ),
      )
    ) {
      return true;
    }
    current = details.cause;
  }
  return false;
}

export async function readConfirmedAllowance({
  read,
  assertCurrent,
  onRetry,
  chainName = 'Base',
}: {
  read: () => Promise<bigint>;
  assertCurrent: () => void;
  onRetry: () => void;
  chainName?: string;
}): Promise<bigint> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assertCurrent();
    try {
      const allowance = await read();
      assertCurrent();
      return allowance;
    } catch (error) {
      assertCurrent();
      if (!isMissingBlock(error)) {
        throw error;
      }
      if (attempt === 7) {
        throw new Error(
          `Approval confirmed, but ${chainName} RPC could not read its block yet. Wait a moment and get a new quote. No swap was sent.`,
        );
      }
      onRetry();
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error('Could not verify token allowance. No swap was sent.');
}
