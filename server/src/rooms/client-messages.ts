import { MAX_SERIAL_HISTORY_CHARS } from '@shared/limits';
import type { ClientMessage, PeerId, SerialPort } from '@shared/ws';

/** Largest `frame.data`: an Ethernet frame of 1514 bytes in base64 is 2020 characters. */
export const MAX_FRAME_CHARS = 2100;
export const MAX_SERIAL_CHARS = 64 * 1024;
export const MAX_INPUT_CHARS = 4 * 1024;
const MAX_MACHINE_ID_CHARS = 64;
const MAX_JOIN_MACHINES = 64;
const PEER_ID_RE = /^[pt][1-9]\d{0,9}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isPeerId = (value: unknown): value is PeerId =>
  typeof value === 'string' && PEER_ID_RE.test(value);

const isPort = (value: unknown): value is SerialPort =>
  value === 0 || value === 2;

const isMachineId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_MACHINE_ID_CHARS;

/** The optional `machine` field: absent is fine, present must be a plausible id. */
function machineField(fields: Fields): { machine?: string } | null {
  if (fields.machine === undefined) return {};
  return isMachineId(fields.machine) ? { machine: fields.machine } : null;
}

function parseJoin(fields: Fields): ClientMessage | null {
  const id = fields.assignment_id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    return null;
  }
  if (fields.machines === undefined) return { type: 'join', assignment_id: id };
  const list = fields.machines;
  if (
    !Array.isArray(list) ||
    list.length > MAX_JOIN_MACHINES ||
    !list.every(isMachineId)
  ) {
    return null;
  }
  return { type: 'join', assignment_id: id, machines: list };
}

function parseSerial(fields: Fields): ClientMessage | null {
  const { data, port, full } = fields;
  if (typeof data !== 'string') return null;
  if (port !== undefined && !isPort(port)) return null;
  if (full !== undefined && full !== true) return null;
  const machine = machineField(fields);
  if (!machine) return null;
  const limit = full === true ? MAX_SERIAL_HISTORY_CHARS : MAX_SERIAL_CHARS;
  if (data.length > limit) return null;
  return {
    type: 'serial',
    data,
    ...(port === undefined ? {} : { port }),
    ...machine,
    ...(full === true ? { full } : {}),
  };
}

function parseInput(fields: Fields): ClientMessage | null {
  const { to, data, port } = fields;
  if (!isPeerId(to) || typeof data !== 'string' || !isPort(port)) return null;
  if (data.length > MAX_INPUT_CHARS) return null;
  const machine = machineField(fields);
  return machine ? { type: 'input', to, data, port, ...machine } : null;
}

function parseFrame(fields: Fields): ClientMessage | null {
  const { to, data } = fields;
  if (!isPeerId(to) || typeof data !== 'string') return null;
  if (data.length > MAX_FRAME_CHARS || !BASE64_RE.test(data)) return null;
  return { type: 'frame', to, data };
}

/**
 * Checks the shape and the size limits that do not depend on the room. Unknown fields are dropped,
 * so the server forwards only what it has looked at. Returns null for anything invalid; the caller
 * discards such a message without a reply.
 */
export function parseClientMessage(text: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'join':
      return parseJoin(value);
    case 'signal':
      return isPeerId(value.to) && 'data' in value
        ? { type: 'signal', to: value.to, data: value.data }
        : null;
    case 'frame':
      return parseFrame(value);
    case 'serial':
      return parseSerial(value);
    case 'input':
      return parseInput(value);
    case 'freeze':
      return typeof value.frozen === 'boolean'
        ? { type: 'freeze', frozen: value.frozen }
        : null;
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}
