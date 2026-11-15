// v86 configurations of the lab machines. `root` is the project root as a URL
// prefix (pages: "../") or a filesystem path with a trailing slash (Node).

const IMAGES = "images/";
// v86.wasm is built from v86det/ (see images-src/v86), not taken from the npm package.
const WASM = root => root + IMAGES + "v86.wasm";

export const PROFILES = {
    buildroot: {
        title: "Buildroot (64 МБ, без диска)",
        prompt: "~% ",
        config: root => ({
            wasm_path: WASM(root), memory_size: 64 << 20,
            bios: { url: root + IMAGES + "seabios.bin" }, vga_bios: { url: root + IMAGES + "vgabios.bin" },
            bzimage: { url: root + IMAGES + "buildroot-bzimage68.bin", async: false }, filesystem: {},
            cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
            net_device: { type: "ne2k" }, uart1: true, uart2: true,
        }),
    },
    net: {
        title: "Net (64 МБ, VLAN, IPv6, iptables, OSPF/RIP, SSH, tcpdump)",
        prompt: "~% ",
        config: root => ({
            wasm_path: WASM(root), memory_size: 64 << 20,
            bios: { url: root + IMAGES + "seabios.bin" }, vga_bios: { url: root + IMAGES + "vgabios.bin" },
            bzimage: { url: root + IMAGES + "net-bzimage.bin", async: false }, filesystem: {},
            cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
            net_device: { type: "ne2k" }, uart1: true, uart2: true,
        }),
    },
    alpine: {
        title: "Alpine 3.21 (128 МБ, python3, gcc, nodejs)",
        prompt: "localhost:~# ",
        config: root => ({
            wasm_path: WASM(root), memory_size: 128 << 20, vga_memory_size: 8 << 20,
            bios: { url: root + IMAGES + "seabios.bin" }, vga_bios: { url: root + IMAGES + "vgabios.bin" },
            filesystem: { baseurl: root + IMAGES + "alpine-rootfs-flat", basefs: root + IMAGES + "alpine-fs.json" },
            bzimage_initrd_from_filesystem: true,
            cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable console=ttyS0",
            net_device: { type: "ne2k" }, uart1: true, uart2: true,
        }),
    },
    study: {
        title: "Study (128 МБ, Alpine з man, bash, vim, g++, git, python3)",
        prompt: "localhost:~# ",
        config: root => ({
            wasm_path: WASM(root), memory_size: 128 << 20, vga_memory_size: 8 << 20,
            bios: { url: root + IMAGES + "seabios.bin" }, vga_bios: { url: root + IMAGES + "vgabios.bin" },
            filesystem: { baseurl: root + IMAGES + "study-rootfs-flat", basefs: root + IMAGES + "study-fs.json" },
            bzimage_initrd_from_filesystem: true,
            cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable console=ttyS0",
            net_device: { type: "ne2k" }, uart1: true, uart2: true,
        }),
    },
};

export const boot_snapshot_path = (root, name) => root + IMAGES + name + "-boot.snap";

// Every machine starts from the same boot snapshot and so has the same MAC;
// on a shared network each gets its own MAC and address (n = 1..254).
export function net_setup_command(n) {
    const hex = n.toString(16).padStart(2, "0");
    return `ifconfig eth0 hw ether 02:00:00:00:00:${hex} 10.0.0.${n} netmask 255.255.255.0 up\n`;
}

// A new live session starts with an empty line: the shell redraws the prompt. The date and the seed are set through the
// system
// channel (`session_command`), so the student terminal shows nothing from the system but the prompt.
export const fresh_session_input = () => "\n";

// Without it the guest shows the date the boot snapshot was taken. The real time is taken on the page's main thread
// (in a Worker the core replaces `Date`).
export const date_command = now_ms => `date -s @${Math.floor(now_ms / 1000)}`;

// Static i386 binary: open("/dev/urandom") and ioctl RNDRESEEDCRNG. Source: images-src/reseed/.
const RESEED_ELF = "f0VMRgEBAQAAAAAAAAAAAAIAAwABAAAAvIAECDQAAAAoAQAAAAAAADQAIAADACgABAADAAEAAACUAAAAlIAECJSABAhvAAAAbwAAAAcAAAAEAAAABAAAAJQAAACUgAQIlIAECCgAAAAoAAAABAAAAAQAAABT5XRklAAAAJSABAiUgAQIKAAAACgAAAAEAAAABAAAAAQAAAAYAAAABQAAAEdOVQABAAHABAAAAAEAAAACAAHABAAAAAAAAAC4BQAAALv2gAQIuQEAAADNgIXAeBmJw7g2AAAAuQdSAADNgPfYicO4AQAAAM2AuwEAAAC4AQAAAM2AL2Rldi91cmFuZG9tAAAuc2hzdHJ0YWIALm5vdGUuZ251LnByb3BlcnR5AC50ZXh0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACwAAAAcAAAACAAAAlIAECJQAAAAoAAAAAAAAAAAAAAAEAAAAAAAAAB4AAAABAAAABwAAALyABAi8AAAARwAAAAAAAAAAAAAAAQAAAAAAAAABAAAAAwAAAAAAAAAAAAAAAwEAACQAAAAAAAAAAAAAAAEAAAAAAAAA";
export const SESSION_ENTROPY_BYTES = 32;
const to_base64 = bytes => btoa(String.fromCharCode(...bytes));

// Command that starts a new live session, for the system channel: the host date, host bytes into the guest pool and an
// immediate reseed
// of the generator. Without the reseed, all sessions from one boot snapshot share the same /dev/urandom for the first
// minute.
// `entropy` is SESSION_ENTROPY_BYTES random bytes from the host's real crypto (in a Worker and in the core process it
// is replaced).
export function session_command(now_ms, entropy) {
    return `${date_command(now_ms)} && echo ${to_base64(entropy)} | base64 -d > /dev/urandom`
        + ` && echo ${RESEED_ELF} | base64 -d > /tmp/.reseed && chmod +x /tmp/.reseed && /tmp/.reseed; r=$?; rm -f /tmp/.reseed; exit $r`;
}

// The system channel and the teacher terminal are started by a command typed into the console before the boot snapshot
// is taken (`engine.node.mjs boot`), the same for every image.
// - ttyS1: a shell loop. A line `@req <id> <base64 command>` runs in a subshell, the answer is a line
//   `@res <id> <return code> <base64 output>` (output up to 64 KiB, binary bytes are safe). Other lines are ignored.
// - ttyS2: a root shell with a controlling terminal (setsid + opening the port without O_NOCTTY), so Ctrl-C works.
// `&` is used in the interactive console shell: in a shell without job control a background process ignores SIGINT.
const AGENT_LOOP = 'exec 3<>/dev/ttyS1; while read -r k i b <&3; do [ "$k" = @req ] || continue; '
    + '(eval "$(echo "$b" | base64 -d)") 3<&- </dev/null >/dev/.agent 2>&1; r=$?; '
    + 'echo "@res $i $r $(head -c 65536 /dev/.agent | base64 | tr -d "\\n")" >&3; done';
const TEACHER_SHELL = 'exec <>/dev/ttyS2 >&0 2>&0; TERM=xterm sh -c "while :; do sh -i; done"';
export const GUEST_SETUP_LINES = [
    "stty -F /dev/ttyS1 raw -echo clocal; stty -F /dev/ttyS2 clocal; "
        + `setsid sh -c '${AGENT_LOOP}' >/dev/null 2>&1 & setsid sh -c '${TEACHER_SHELL}' >/dev/null 2>&1 &\n`,
    "clear\n",
];

const ROOM_NETMASK = "255.255.255.0";
const DHCP_COMMAND = "udhcpc -i eth0 -q -n -t 4 -T 3";

// Network setup command of a lab machine (null means there is nothing to set up).
// The relay's DHCP goes before the room address: DHCP would replace the first address, but leaves the second one
// (eth0:1) alone.
export function lab_net_command({ mac, n, internet }) {
    const room_address = `10.0.0.${n} netmask ${ROOM_NETMASK}`;
    if(!internet) return n === null ? null : `ifconfig eth0 hw ether ${mac} ${room_address} up\n`;
    const dhcp = `ifconfig eth0 hw ether ${mac} up; ${DHCP_COMMAND}`;
    return n === null ? `${dhcp}\n` : `${dhcp}; ifconfig eth0:1 ${room_address} up\n`;
}
