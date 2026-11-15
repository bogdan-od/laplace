// Boots a bzImage in v86 (Node), waits for the `~% ` prompt and runs the commands one by one.
// Usage: node guest-run.mjs <bzimage> [--nic] <command> [<command> ...]
// Prints the time to the first prompt and the output of each command.
// --nic: before the commands, checks the network card: the guest gets an ARP request for its address
// 10.0.0.2 and must answer with an ARP reply (checks the IRQ and ne2k receive/transmit).
import { V86 } from "v86";

const ROOT = new URL("../../", import.meta.url).pathname;
const IMAGES = ROOT + "images/";
const PROMPT = "~% ";
const BOOT_TIMEOUT_MS = 120000;
const COMMAND_TIMEOUT_MS = 30000;

const args = process.argv.slice(2);
const nic_test = args.includes("--nic");
const [bzimage, ...commands] = args.filter(arg => arg !== "--nic");
if(!bzimage) {
    console.error("usage: node guest-run.mjs <bzimage> [--nic] <command>...");
    process.exit(2);
}

const emulator = new V86({
    wasm_path: ROOT + "node_modules/v86/build/v86.wasm", memory_size: 64 << 20,
    bios: { url: IMAGES + "seabios.bin" }, vga_bios: { url: IMAGES + "vgabios.bin" },
    bzimage: { url: bzimage, async: false }, filesystem: {},
    cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
    net_device: { type: "ne2k" }, autostart: true, disable_keyboard: true,
});

let out = "";
let waiting = null;
emulator.add_listener("serial0-output-byte", byte => {
    out += String.fromCharCode(byte);
    if(waiting && out.endsWith(PROMPT)) waiting();
});

const wait_prompt = timeout_ms => new Promise((resolve, reject) => {
    if(out.endsWith(PROMPT)) return resolve();
    const timer = setTimeout(() => reject(new Error("timeout, tail of the output:\n" + out.slice(-800))), timeout_ms);
    waiting = () => { clearTimeout(timer); waiting = null; resolve(); };
});

const ARP_REQUEST = Uint8Array.from([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0, 0, 0, 0, 0x99, 0x08, 0x06,
    0, 1, 0x08, 0, 6, 4, 0, 1, 0x02, 0, 0, 0, 0, 0x99, 10, 0, 0, 9,
    0, 0, 0, 0, 0, 0, 10, 0, 0, 2,
]);
const ARP_REPLY_OPCODE = 2;
const ARP_OPCODE_OFFSET = 20;
const ETHERTYPE_ARP_OFFSET = 12;
let arp_replied = false;
emulator.add_listener("net0-send", frame => {
    if(frame[ETHERTYPE_ARP_OFFSET] === 0x08 && frame[ETHERTYPE_ARP_OFFSET + 1] === 0x06
        && frame[ARP_OPCODE_OFFSET + 1] === ARP_REPLY_OPCODE) arp_replied = true;
});

const started = Date.now();
try {
    await wait_prompt(BOOT_TIMEOUT_MS);
    console.log(`prompt after ${(Date.now() - started) / 1000} s`);
    if(nic_test) {
        out = "";
        emulator.serial0_send("ifconfig eth0 10.0.0.2 netmask 255.255.255.0 up\n");
        await wait_prompt(COMMAND_TIMEOUT_MS);
        emulator.bus.send("net0-receive", ARP_REQUEST);
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`### nic: guest ARP reply ${arp_replied ? "received" : "NOT RECEIVED"}`);
        if(!arp_replied) process.exitCode = 1;
    }
    for(const command of commands) {
        out = "";
        emulator.serial0_send(command + "\n");
        await wait_prompt(COMMAND_TIMEOUT_MS);
        console.log(`### ${command}\n${out.replace(/\r/g, "").replace(command + "\n", "").replace(/~% $/, "").trimEnd()}`);
    }
} catch(error) {
    console.error(error.message);
    process.exitCode = 1;
}
emulator.stop();
process.exit();
