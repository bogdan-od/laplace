const DEFAULT_PORT = 8086;
const MAX_PORT = 65_535;

/** The listen port from the `PORT` variable; throws a readable error for anything but 1..65535. */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PORT) {
    throw new Error(
      `PORT must be an integer from 1 to ${MAX_PORT}, got "${raw}"`,
    );
  }
  return value;
}
