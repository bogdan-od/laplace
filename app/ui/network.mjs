import { number_of } from "../net/room.mjs";
import { Relay } from "../net/relay.mjs";
import { random_mac } from "../net/mac.mjs";
import { lab_net_command, PROFILES } from "../profiles.mjs";
import { $, show_error } from "./common.mjs";

const MAX_HOST = 254;
const PROMPT_TAIL_CHARS = 4096;

// Resolves when the machine has become live and the shell has printed its prompt.
// Call before machine.start(): events that came before the subscription are lost.
export function shell_ready(machine, profile) {
    const prompt = PROFILES[profile].prompt;
    const decoder = new TextDecoder();
    let tail = "";
    let live = false;
    return new Promise(resolve => {
        const check = () => live && tail.includes(prompt) && resolve();
        machine.on("serial", bytes => {
            tail = (tail + decoder.decode(bytes, { stream: true })).slice(-PROMPT_TAIL_CHARS);
            check();
        });
        machine.on("status", status => {
            live = status.mode === "live";
            check();
        });
    });
}

// Network of a lab machine: the relay (optional) and, in a room, the neighbours. It connects
// only after start(), that is, in live mode after the shell prompt.
export class Network {
    relay = null;
    n = null;
    room = null;
    #machine;
    #router;
    #relay_url;
    #command = null;

    constructor(machine, router, { relay_url }) {
        this.#machine = machine;
        this.#router = router;
        this.#relay_url = relay_url;
    }

        async start(ready, room) {
        this.room = room;
        if(!this.#relay_url && !room) this.#render();
        await ready;
        if(room) {
            this.n = number_of(room.id);
            if(this.n > MAX_HOST) return show_error(`Кімната: номер ${this.n} більше 254, мережі не буде`);
            room.mesh.addEventListener("change", () => this.#render());
        }
        if(this.#relay_url) await this.#connect_relay();
        this.#command = lab_net_command({ mac: random_mac(), n: this.n, internet: this.relay?.is_open ?? false });
        this.reconfigure();
        this.#render();
    }

    // After a rollback to the very start the guest has no address again: the same command with the same MAC.
    reconfigure() {
        if(this.#command) this.#machine.run_setup(this.#command);
    }

    async #connect_relay() {
        this.relay = new Relay(this.#relay_url, frame => this.#router.from_relay(frame));
        this.relay.addEventListener("change", () => this.#render());
        this.#router.attach_relay(this.relay);
        await this.relay.settled;
    }

    #render() {
        const internet = this.#internet_text();
        $("net").textContent = this.n === null ? internet : `Адреса 10.0.0.${this.n}, сусідів: ${this.#neighbours_text()}, ${internet}`;
    }

    #neighbours_text() {
        const { peer_count, server_count } = this.room.mesh;
        return server_count ? `${peer_count} (${server_count} через сервер)` : `${peer_count}`;
    }

    #internet_text() {
        if(!this.#relay_url) return this.room ? "інтернет: ні" : "без інтернету";
        if(!this.relay || this.relay.state === "connecting") return "інтернет: з'єднання…";
        return this.relay.is_open ? `інтернет: ${this.relay.host}` : "інтернет: відключено, перепідключаюсь";
    }
}
