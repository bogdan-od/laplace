import type { Readable } from 'node:stream';
import { ApiException } from '../common/api-exception';

/** Reads a stream into one Buffer, giving up with 413 `journal_too_large` past `maxBytes`. */
export async function collect(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new ApiException(413, 'Журнал завеликий', 'journal_too_large');
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
