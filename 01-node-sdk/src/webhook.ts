import type { IncomingMessage, ServerResponse } from 'node:http'
import type Facturino from '@facturino/node'
import { FacturinoError, type WebhookEvent } from '@facturino/node'

import type { Config } from './config.js'
import { log } from './lib.js'

/** Read the raw request body bytes — required BEFORE any JSON parsing so the
 * signed payload matches exactly what Facturino signed. */
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Dispatch a verified event to the matching handler. */
function handleEvent(event: WebhookEvent): void {
  const object = event.data.object
  switch (event.type) {
    case 'invoice.finalized':
      log.ok(`[webhook] invoice ${object} finalized → number assigned, archive sealed`)
      break
    case 'invoice.transmitted':
      log.ok(`[webhook] invoice ${object} transmitted to the PA (DGFiP "Émise")`)
      break
    case 'invoice.paid':
      log.ok(`[webhook] invoice ${object} paid → mark the SaaS subscription active`)
      break
    case 'invoice.partially_paid':
      log.info(`[webhook] invoice ${object} partially paid`)
      break
    case 'quote.accepted':
      log.ok(`[webhook] quote ${object} accepted → ready to convert to an invoice`)
      break
    case 'credit_note.finalized':
      log.ok(`[webhook] credit note ${object} finalized`)
      break
    case 'invoice.incoming.received':
      log.info(`[webhook] supplier invoice ${object} received in the inbox`)
      break
    default:
      // Unknown / unsubscribed type: acknowledge but take no action.
      log.info(`[webhook] ${event.type} (no handler) id=${event.id}`)
  }
}

/**
 * HTTP handler for `POST /webhooks`.
 *
 * Verifies the `Facturino-Signature` header with the SDK helper
 * (`webhooks.constructEvent`), which:
 *   1. parses `t=<ts>,v1=<sig>`,
 *   2. recomputes HMAC-SHA256(secret, `${ts}.${rawBody}`),
 *   3. constant-time compares the signatures,
 *   4. rejects events outside the timestamp tolerance window,
 *   5. returns the parsed, trusted event envelope.
 *
 * Always returns 2xx fast once verified so Facturino does not retry; the
 * actual work should be queued, but for the demo we process inline.
 */
export async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  f: Facturino,
  config: Config,
): Promise<void> {
  // The raw body MUST be read before parsing — the signature covers raw bytes.
  const rawBody = await readRawBody(req)
  const signature = req.headers['facturino-signature']

  if (!config.webhookSecret) {
    log.warn('[webhook] FACTURINO_WEBHOOK_SECRET is not set — cannot verify; rejecting')
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'webhook secret not configured' }))
    return
  }

  if (typeof signature !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'missing Facturino-Signature header' }))
    return
  }

  let event: WebhookEvent
  try {
    // Verifies the signature AND parses the JSON in one call.
    event = f.webhooks.constructEvent(rawBody, signature, config.webhookSecret)
  } catch (err) {
    // FacturinoError covers bad signature, malformed header, or stale timestamp.
    const message = err instanceof FacturinoError ? err.message : String(err)
    log.warn(`[webhook] signature verification failed: ${message}`)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid signature' }))
    return
  }

  try {
    handleEvent(event)
  } catch (err) {
    // Never throw back to Facturino once verified — log and still 200 so the
    // event is not retried for an internal handler bug. Re-queue instead.
    log.warn(`[webhook] handler error for ${event.type}: ${String(err)}`)
  }

  // Acknowledge receipt.
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ received: true, type: event.type, id: event.id }))
}
