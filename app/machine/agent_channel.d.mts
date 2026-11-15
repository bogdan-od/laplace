export interface AgentResult {
    /** Return code of the command. Nobody checks it by default. */
    rc: number;
    /** stdout and stderr together, up to 64 KiB. */
    output: string;
}

export interface AgentResponse extends AgentResult {
    id: string;
}

export function encode_request(id: string, command: string): string;
/** `null` if the line is not a response or is corrupted. */
export function parse_response(line: string): AgentResponse | null;

export interface AgentChannelOptions {
    /** Whether the emulator is standing still and cannot run the guest; stalled time does not count toward a timeout (at most 120 s). */
    stalled?: () => boolean;
}

export class AgentChannel {
    #private;
    /** `send(text)` writes text to the guest's ttyS1. */
    constructor(send: (text: string) => void, options?: AgentChannelOptions);
    /** Rejects on timeout; a command that never finishes blocks the agent, and all later requests time out. */
    request(command: string, timeout_ms: number): Promise<AgentResult>;
    /** Bytes read from ttyS1. Lines that are not responses to our requests are ignored. */
    feed(bytes: Uint8Array): void;
    reject_all(error: Error): void;
}
