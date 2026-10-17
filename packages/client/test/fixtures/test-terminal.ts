import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

/** Minimal recording Terminal that drives the actual released pi-tui editor/input/render path in tests. */
export class TestTerminal implements Terminal {
  output = "";
  columns = 100;
  rows = 24;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  stopped = false;
  start(input: (data: string) => void): void { this.input = input; }
  stop(): void { this.stopped = true; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}
  /** Type printable text one character at a time through the real input path. */
  type(text: string): void { for (const character of text) this.input!(character); }
}
