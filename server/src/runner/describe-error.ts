/**
 * What may go to the log about a crash: the error's name and its stack frames. The message is left
 * out because a parser error can quote a piece of the journal, and journals are secret.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error thrown';
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '));
  return [error.name, ...frames.slice(0, 8)].join('\n');
}
