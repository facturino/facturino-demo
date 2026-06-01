/**
 * Webhook signature verification — by hand.
 *
 * Facturino signs every delivery with a header:
 *
 *     Facturino-Signature: t=<unixSeconds>,v1=<hexHmac>
 *
 * The signed payload is the string `` `${t}.${rawBody}` ``, where `rawBody`
 * is the EXACT bytes of the request body (you MUST read it before any JSON
 * parsing — re-serialising the parsed object would change byte-for-byte
 * content and break the signature). The signature is
 * `HMAC-SHA256(secret, signedPayload)` hex-encoded.
 *
 * This is what `facturino.webhooks.constructEvent()` does inside the SDKs.
 * We reimplement it with `node:crypto` only.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Reject deliveries whose timestamp is older/newer than this (anti-replay). */
export const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes — matches the server.

/** The event envelope Facturino POSTs to your endpoint. */
export interface WebhookEvent<T = unknown> {
  /** Event id, `evt_…`. Store it to dedupe — delivery is at-least-once. */
  id: string;
  object: 'event';
  /** e.g. `invoice.finalized`, `invoice.paid`, `quote.accepted`. */
  type: string;
  apiVersion?: string;
  /** ISO 8601 creation timestamp. */
  created: string;
  livemode: boolean;
  /** The resource that changed lives under `data.object`. */
  data: { object: T };
  request?: { id?: string; idempotencyKey?: string } | null;
}

/** Outcome of {@link verifyWebhookSignature}. */
export type VerifyResult =
  | { ok: true; event: WebhookEvent }
  | { ok: false; reason: string };

/**
 * Verify the `Facturino-Signature` header against the raw request body, then
 * parse and return the event. Returns a discriminated result instead of
 * throwing so the HTTP layer can map failures to `400`.
 *
 * Order of checks (each one matters):
 *   1. Parse the header into `t` and `v1`.
 *   2. Reject stale/future timestamps (replay protection).
 *   3. Recompute the HMAC over `${t}.${rawBody}` and compare timing-safe.
 *   4. Only then parse the JSON — never trust unverified bytes.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  if (!signatureHeader) {
    return { ok: false, reason: 'missing Facturino-Signature header' };
  }

  // Header format: "t=1717000000,v1=abcdef…". Split on commas, find the parts.
  const parts = signatureHeader.split(',').map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) {
    return { ok: false, reason: 'malformed signature header (need t= and v1=)' };
  }

  const timestamp = Number.parseInt(timestampPart.slice('t='.length), 10);
  const receivedSignature = signaturePart.slice('v1='.length);

  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'invalid timestamp in signature header' };
  }

  // Anti-replay: reject if the timestamp drifts beyond tolerance in EITHER
  // direction (old replays *and* clock-skewed futures).
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return {
      ok: false,
      reason: `timestamp outside tolerance (${Math.abs(nowSeconds - timestamp)}s > ${toleranceSeconds}s)`,
    };
  }

  // Recompute the expected signature over the EXACT raw body.
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Constant-time comparison to avoid leaking the secret via timing. Both
  // buffers must be the same length, or timingSafeEqual throws — guard first.
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const receivedBuffer = Buffer.from(receivedSignature, 'hex');
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return { ok: false, reason: 'signature mismatch' };
  }

  // Signature is valid — now it is safe to parse the JSON body.
  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody) as WebhookEvent;
  } catch {
    return { ok: false, reason: 'verified body is not valid JSON' };
  }

  return { ok: true, event };
}
