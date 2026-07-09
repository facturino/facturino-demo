import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '@facturino/node'

/**
 * Identifier for this execution of the demo. Mixed into every idempotency key
 * so each run is a self-contained, repeatable scenario: re-running the demo
 * creates a fresh dataset instead of colliding with a previous run, while a
 * step retried *within* the same run still reuses its key.
 */
const RUN_ID = randomUUID()

/**
 * Build an `Idempotency-Key` for a logical operation in this run.
 *
 * The SDK forwards `options.idempotencyKey` as the `Idempotency-Key` header on
 * POST requests. Facturino guarantees that two POSTs sharing a key return the
 * same resource, so if a step is retried after a network blip it never creates
 * a duplicate. The key is derived from this run's id plus a stable `scope`
 * (e.g. `"create-customer"`) and the identifying inputs.
 */
export function idempotencyKey(scope: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update([RUN_ID, scope, ...parts].join('|'))
    .digest('hex')
    .slice(0, 32)
  return `demo_${scope}_${digest}`
}

/**
 * Format an integer-cents amount as a euro string. Facturino represents every
 * monetary value as integer cents (e.g. `9900` → `99.00 €`), so the display
 * layer divides by 100 — never do arithmetic on the formatted value.
 */
export function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`
}

/** Minimal structured logger so the scenario reads like a transcript. */
export const log = {
  step(letter: string, title: string): void {
    console.log(`\n=== ${letter}. ${title} ===`)
  },
  info(message: string, detail?: unknown): void {
    if (detail === undefined) console.log(`  ${message}`)
    else console.log(`  ${message}`, detail)
  },
  ok(message: string): void {
    console.log(`  ✓ ${message}`)
  },
  skip(message: string): void {
    console.log(`  · (skipped) ${message}`)
  },
  warn(message: string): void {
    console.warn(`  ! ${message}`)
  },
}

/**
 * Format any thrown value for the operator, always surfacing `request_id` on
 * API errors. The `request_id` is what Facturino support needs to trace a
 * failing call — never swallow it.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const lines = [
      `Facturino API error (${err.status} ${err.type}/${err.code}): ${err.message}`,
      `    request_id: ${err.requestId}`,
    ]
    if (err.param) lines.push(`    param: ${err.param}`)
    if (err.hint) lines.push(`    hint: ${err.hint}`)
    if (err.docUrl) lines.push(`    doc: ${err.docUrl}`)
    return lines.join('\n')
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

/**
 * Some endpoints return EITHER a ready signed-URL document OR a 202-style job
 * descriptor when generation is asynchronous. This narrows the union.
 */
export function isJobResponse(
  value: { url?: string; id?: string; object?: string },
): value is { id: string; object: 'job'; type: string; status: string } {
  return value.object === 'job'
}

/** Today and `+days` as `YYYY-MM-DD` (the API expects ISO date strings). */
export function isoDate(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

/** Full ISO 8601 timestamp (date + time), for fields that require a datetime. */
export function isoDateTime(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString()
}

/** Current month as `YYYY-MM` (used by e-reporting / reporting periods). */
export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7)
}
