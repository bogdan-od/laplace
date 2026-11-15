const RELAY_PARAM = "relay";
const RELAY_OFF = "off";
const CONFIG_URL = new URL("../config.json", import.meta.url);
const WISP_PROTOCOLS = ["wisp:", "wisps:"];
const WSPROXY_PROTOCOLS = ["ws:", "wss:"];

// Relay address or null. Sources by priority: the page parameter, then app/config.json.
export async function read_relay_url(params) {
    const override = params.get(RELAY_PARAM);
    if(override === RELAY_OFF) return null;
    const raw = override ?? await relay_from_file();
    return raw === null ? null : checked_relay_url(raw);
}

async function relay_from_file() {
    const response = await fetch(CONFIG_URL, { cache: "no-store" });
    if(!response.ok) return null;
    const relay = (await response.json()).relay ?? null;
    if(relay !== null && typeof relay !== "string") throw new Error("config.json: relay має бути рядком або null");
    return relay;
}

function checked_relay_url(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch (error) {
        if(!(error instanceof TypeError)) throw error;
        throw new Error(`Ретранслятор: некоректна адреса ${raw}`);
    }
    if(WISP_PROTOCOLS.includes(url.protocol)) throw new Error("WISP ще не підтримується");
    if(!WSPROXY_PROTOCOLS.includes(url.protocol)) throw new Error(`Ретранслятор: потрібна адреса ws:// або wss://, а не ${raw}`);
    return url.href;
}
