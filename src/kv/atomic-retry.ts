export async function waitForKvAtomicRetry(attempt: number): Promise<void> {
  const baseMs = Math.min(10 * 2 ** attempt, 500);
  const jitter = Math.random() * baseMs;
  await new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
}
