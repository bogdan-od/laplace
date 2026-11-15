// A screenless terminal that follows the console of a student's machine for the teacher's tile. The shell sends
// backspaces, `ESC [ K` and carriage returns, so the text of the screen comes from a real terminal emulator.

import { Terminal } from "@xterm/headless";

export const SCREEN_COLS = 80;
export const SCREEN_ROWS = 24;
// `Terminal.buffer` is marked proposed in the typings, though it is the only way to read the screen.
const RESET = "\x1bc";

export class ScreenMirror {
  readonly #terminal = new Terminal({ cols: SCREEN_COLS, rows: SCREEN_ROWS, scrollback: 0, allowProposedApi: true });

  /** `replace` clears the screen first (a full history from the student, or `ESC c` after a rollback). Resolves once parsed. */
  write(bytes: Uint8Array, replace: boolean): Promise<void> {
    // The reset goes through the same queue as the data, so it cannot overtake an earlier write.
    if (replace) this.#terminal.write(RESET);
    return new Promise((done) => this.#terminal.write(bytes, done));
  }

  /** The rows of the screen without the empty ones at the end. */
  lines(): string[] {
    const buffer = this.#terminal.buffer.active;
    const rows: string[] = [];
    for (let row = 0; row < SCREEN_ROWS; row++) {
      rows.push((buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").trimEnd());
    }
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows;
  }

  dispose(): void {
    this.#terminal.dispose();
  }
}
