export type ProfileName = "buildroot" | "net" | "alpine" | "study";

export interface V86Config {
    wasm_path: string;
    memory_size: number;
    vga_memory_size?: number;
    bios: { url: string };
    vga_bios: { url: string };
    /** Only for profiles without an initrd from the filesystem (`buildroot`, `net`). */
    bzimage?: { url: string; async: boolean };
    filesystem: { baseurl?: string; basefs?: string };
    bzimage_initrd_from_filesystem?: boolean;
    cmdline: string;
    net_device: { type: "ne2k" };
    uart1: boolean;
    uart2: boolean;
}

export interface Profile {
    title: string;
    /** Shell prompt; pages use it to tell that the guest is ready. */
    prompt: string;
    /** `root` is a page URL prefix (`"../"`) or a filesystem path with a trailing slash (Node). */
    config(root: string): V86Config;
}

export const PROFILES: Record<ProfileName, Profile>;

export function boot_snapshot_path(root: string, name: ProfileName): string;
/** Network setup command; `n` is 1..254. */
export function net_setup_command(n: number): string;
export function fresh_session_input(): string;
export function date_command(now_ms: number): string;

export const SESSION_ENTROPY_BYTES: number;
/** `entropy` is `SESSION_ENTROPY_BYTES` bytes from the host's real `crypto` (the engine replaces it in a Worker). */
export function session_command(now_ms: number, entropy: Uint8Array): string;

export const GUEST_SETUP_LINES: readonly string[];

export interface LabNetOptions {
    mac: string;
    /** Room number (address `10.0.0.N`), or `null` outside a room. */
    n: number | null;
    internet: boolean;
}
/** `null` means there is nothing to configure. */
export function lab_net_command(options: LabNetOptions): string | null;
