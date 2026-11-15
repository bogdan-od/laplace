import { Socket } from "./socket";

/** The tab's only WebSocket; the shell connects it after login. */
export const socket = new Socket();
