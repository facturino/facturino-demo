/**
 * Tiny structured logger. No dependency — just timestamped lines on stdout,
 * plus helpers that make a scenario run readable in a terminal.
 */

let stepCounter = 0;

/** Print a top-level scenario phase banner (A, B, C…). */
export function phase(letter: string, title: string): void {
  console.log(`\n\x1b[1m\x1b[38;5;208m▌ ${letter}. ${title}\x1b[0m`);
}

/** Print a numbered step inside a phase. */
export function step(label: string): void {
  stepCounter++;
  console.log(`  \x1b[38;5;245m${String(stepCounter).padStart(2, '0')}\x1b[0m ${label}`);
}

/** Print a sub-detail under a step (the interesting field from a response). */
export function detail(message: string): void {
  console.log(`     \x1b[38;5;245m↳\x1b[0m ${message}`);
}

/** Print a warning (skipped/guarded operations). */
export function warn(message: string): void {
  console.log(`     \x1b[38;5;214m⚠\x1b[0m ${message}`);
}

/** Print an error line. */
export function fail(message: string): void {
  console.log(`     \x1b[38;5;196m✗\x1b[0m ${message}`);
}

/** Reset the step counter between runs. */
export function resetSteps(): void {
  stepCounter = 0;
}
