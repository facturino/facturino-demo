import { createHash } from 'node:crypto'
import { ApiError } from '@facturino/node'

/**
 * Build a deterministic `Idempotency-Key` for a given logical operation.
 *
 * The SDK forwards `options.idempotencyKey` as the `Idempotency-Key` header on
 * POSTs. We derive the key from a stable `scope` (e.g. "create-customer") plus
 * the identifying inputs, so a retried run reuses the SAME key and the API
 * returns the original resource instead of creating a duplicate. Regenerated
 * per step, stable across retries — exactly the scenario's contract.
 */
export function idempotencyKey(scope: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update([scope, ...parts].join('|'))
    .digest('hex')
    .slice(0, 32)
  return `demo_${scope}_${digest}`
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

/** Current month as `YYYY-MM` (used by e-reporting / reporting periods). */
export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7)
}
