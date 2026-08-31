/**
 * Demo HTTP server (node:http only).
 *
 * Two responsibilities:
 *   1. Trigger the scenario on demand:
 *        POST /run            → the full A→K workflow
 *   2. Receive Facturino webhooks:
 *        POST /webhooks       → verify signature BY HAND, then process events
 *
 * It is deliberately tiny: no framework, no router library. The interesting
 * code is the raw-body capture in `readRawBody` and the hand-rolled signature
 * check in `webhook.ts`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { Scenario } from './scenario.js';
import { verifyWebhookSignature, type WebhookEvent } from './webhook.js';

const config = loadConfig();
const scenario = new Scenario(config);

/**
 * Read the FULL raw request body as a UTF-8 string. For webhooks this MUST
 * happen before any JSON parsing — the signature is computed over these exact
 * bytes, so re-serialising a parsed object would not match.
 */
function readRawBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * Process a verified webhook event. This is where a real SaaS reconciles its
 * own state: mark an invoice paid in your DB, notify a customer, etc. Here we
 * just log and acknowledge. Deduplicate on `event.id` (delivery is
 * at-least-once) — a production app would persist seen ids.
 */
const seenEventIds = new Set<string>();

function handleEvent(event: WebhookEvent): void {
  if (seenEventIds.has(event.id)) {
    console.log(`  ↺ webhook ${event.type} ${event.id} (duplicate — already processed)`);
    return;
  }
  seenEventIds.add(event.id);

  console.log(`  ✓ webhook ${event.type} ${event.id} (livemode=${event.livemode})`);

  switch (event.type) {
    case 'invoice.finalized':
    case 'invoice.transmitted':
    case 'invoice.paid':
    case 'quote.accepted':
    case 'credit_note.finalized':
      // The resource that changed is at event.data.object.
      console.log(`     handled ${event.type}`);
      break;
    default:
      console.log(`     received (no specific handler): ${event.type}`);
  }
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 1. Raw body FIRST — required for signature verification.
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    sendJson(res, 413, { error: 'payload too large' });
    return;
  }

  // 2. Verify the Facturino-Signature header by hand.
  const signature = req.headers['facturino-signature'];
  const result = verifyWebhookSignature(
    rawBody,
    Array.isArray(signature) ? signature[0] : signature,
    config.webhookSecret,
  );

  if (!result.ok) {
    // Never process an unverified payload. 400 tells Facturino it failed so it
    // can retry (the retry would still fail if the secret is wrong — fix the
    // secret, then use events.retry to replay).
    console.warn(`  ✗ webhook rejected: ${result.reason}`);
    sendJson(res, 400, { error: { message: `signature verification failed: ${result.reason}` } });
    return;
  }

  // 3. Acknowledge fast (200), THEN process. Long processing should be queued
  //    so Facturino's 30s delivery timeout never trips. We process inline here
  //    because the demo handlers are trivial.
  sendJson(res, 200, { received: true });
  handleEvent(result.event);
}

async function handleRun(res: ServerResponse): Promise<void> {
  try {
    const ctx = await scenario.runAll();
    sendJson(res, 200, { ok: true, context: ctx });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('scenario failed:', message);
    sendJson(res, 500, { error: { message } });
  }
}

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    service: 'facturino-demo-no-sdk',
    baseUrl: config.baseUrl,
    livemode: config.livemode,
    webhookSecretConfigured: config.webhookSecret.startsWith('whsec_'),
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  void (async () => {
    try {
      if (method === 'GET' && (path === '/' || path === '/health')) {
        handleHealth(res);
        return;
      }
      if (method === 'POST' && path === '/webhooks') {
        await handleWebhook(req, res);
        return;
      }
      if (method === 'POST' && path === '/run') {
        await handleRun(res);
        return;
      }
      sendJson(res, 404, { error: { message: `Cannot ${method} ${path}` } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: { message } });
    }
  })();
});

server.listen(config.port, () => {
  console.log(`\x1b[1mFacturino no-SDK demo\x1b[0m listening on http://localhost:${config.port}`);
  console.log(`  API base   : ${config.baseUrl}`);
  console.log(`  Live mode  : ${config.livemode}`);
  console.log(`  Public URL : ${config.publicBaseUrl || '(unset — webhooks unreachable from Facturino)'}`);
  console.log('');
  console.log('  POST /run            run the full A→K scenario');
  console.log('  POST /webhooks       receive + verify Facturino webhooks');
  console.log('  GET  /health         liveness + config sanity check');
  console.log('');
  console.log('  Tip: trigger the workflow with  curl -XPOST http://localhost:' + config.port + '/run');
});
