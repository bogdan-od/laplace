/** The usual median: the middle value, or the mean of the two middle ones; null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const high = sorted[middle];
  const low = sorted[middle - 1];
  if (high === undefined) return null;
  if (sorted.length % 2 === 1 || low === undefined) return high;
  return (low + high) / 2;
}
