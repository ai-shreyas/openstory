/**
 * After the (scene × model) fan-out, retry a lone failed PRIMARY image once
 * before the parent returns. One miss of seven shouldn't headline the
 * scenes page (#1286); more than one failure is a real partial fail.
 */

export function loneFailedPrimaryJobIndex(
  jobs: ReadonlyArray<{ model: string }>,
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
  primaryModel: string
): number | null {
  const primaryIndexes: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    if (jobs[i]?.model === primaryModel) primaryIndexes.push(i);
  }
  const failed = primaryIndexes.filter(
    (i) => results[i]?.status === 'rejected'
  );
  return failed.length === 1 ? (failed[0] ?? null) : null;
}
