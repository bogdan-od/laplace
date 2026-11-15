import type { ChunkInfo } from '@shared/api';

/**
 * The part of a stored chunk that lies in events [from, to) of the journal. A chunk cut by the
 * range keeps its arrival time and gets a proportional share of its size: the exact size of a
 * part is not stored.
 */
export function clipChunk(
  chunk: ChunkInfo,
  from: number,
  to: number,
): ChunkInfo | null {
  const start = Math.max(chunk.first_event, from);
  const end = Math.min(chunk.first_event + chunk.event_count, to);
  if (end <= start) return null;
  const count = end - start;
  if (count === chunk.event_count) return chunk;
  return {
    first_event: start,
    event_count: count,
    bytes: Math.round((chunk.bytes * count) / chunk.event_count),
    received_at: chunk.received_at,
  };
}
