import { formatWithOptions } from "node:util";

// Escape every terminal control except LF and tab. This is safe even when a
// control sequence spans chunks; it does not need an incomplete-sequence buffer.
export function terminalText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    character => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function terminalError(error: unknown): Error {
  return new Error(terminalText(error instanceof Error ? error.message : String(error)));
}

export function reportError(message: string, error: unknown): void {
  console.error(terminalText(formatWithOptions({ colors: false }, message, error)));
}
