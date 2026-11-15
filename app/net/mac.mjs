const MAC_RANDOM_BYTES = 5;
const LOCAL_UNICAST_FIRST_BYTE = "02";

// The page rather than the Worker: the journal records the resulting setup command, not the random number itself.
export function random_mac() {
    const bytes = crypto.getRandomValues(new Uint8Array(MAC_RANDOM_BYTES));
    return [LOCAL_UNICAST_FIRST_BYTE, ...Array.from(bytes, byte => byte.toString(16).padStart(2, "0"))].join(":");
}
