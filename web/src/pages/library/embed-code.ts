const FRAME_WIDTH = 960;
const FRAME_HEIGHT = 640;

/** Where the published player lives: the `/embed/:token` route of this app. */
export function embedAddress(token: string, origin: string): string {
  return `${origin}/embed/${token}`;
}

export function iframeCode(address: string): string {
  return `<iframe src="${address}" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}"></iframe>`;
}
