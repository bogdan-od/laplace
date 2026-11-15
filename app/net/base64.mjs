const CHUNK = 0x8000;

export function to_base64(bytes) {
    let text = "";
    for(let start = 0; start < bytes.length; start += CHUNK) {
        text += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
    }
    return btoa(text);
}

export function from_base64(text) {
    return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}
