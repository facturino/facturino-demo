import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { loadConfig, createClient } from './config.js'
import { describeError, log } from './lib.js'
import { Scenario, runScenario, type RunFlags } from './scenario.js'
import { handleWebhook } from './webhook.js'

/**
 * Minimal HTTP server (node:http, no framework) exposing:
 *
 *   GET  /                — health + route index
 *   POST /run             — the full A→J scenario
 *   POST /run/:phase      — a single phase (bootstrap, catalogue, customer, …)
 *   POST /webhooks        — inbound Facturino events (signature-verified)
 *
 * Sensitive calls (account deletion, real Stripe checkout, member/key revoke,
 * PA disconnect) stay disabled unless explicitly enabled via env flags:
 *   ALLOW_ACCOUNT_DELETION=1 ALLOW_BILLING_MUTATIONS=1
 *   ALLOW_MEMBER_MUTATIONS=1 ALLOW_PA_DISCONNECT=1
 */

const config = loadConfig()
const facturino = createClient(config)

function readFlags(): RunFlags {
  return {
    allowAccountDeletion: process.env.ALLOW_ACCOUNT_DELETION === '1',
    allowBillingMutations: process.env.ALLOW_BILLING_MUTATIONS === '1',
    allowMemberMutations: process.env.ALLOW_MEMBER_MUTATIONS === '1',
    allowPaDisconnect: process.env.ALLOW_PA_DISCONNECT === '1',
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

const PHASES = [
  'bootstrap',
  'catalogue',
  'customer',
  'quote',
  'validate',
  'invoice',
  'recurring',
  'creditNote',
  'purchases',
  'webhooks',
  'accounting',
  'administration',
  'illustrative',
] as const
type Phase = (typeof PHASES)[number]

/**
 * Run a single phase. Most phases depend on resources produced by earlier
 * ones, so when invoked standalone we rebuild the minimal prerequisites first.
 */
async function runPhase(phase: Phase, flags: RunFlags): Promise<void> {
  const scenario = new Scenario(facturino, config, flags)

  switch (phase) {
    case 'bootstrap':
      await scenario.bootstrap()
      return
    case 'catalogue':
      await scenario.catalogue()
      return
    case 'customer':
      await scenario.customer()
      return
    case 'webhooks':
      await scenario.webhooks()
      return
    case 'accounting':
      await scenario.accounting()
      return
    case 'illustrative':
      await scenario.illustrative()
      return
  }

  // Phases below need upstream resources — rebuild them (all idempotent).
  const { account, company } = await scenario.bootstrap()
  const { subscription, service } = await scenario.catalogue()
  const customer = await scenario.customer()

  switch (phase) {
    case 'quote':
      await scenario.quoteToInvoice(customer, service)
      return
    case 'validate':
      await scenario.validateUpstream(customer, service)
      return
    case 'recurring':
      await scenario.recurring(customer, subscription)
      return
    case 'administration':
      await scenario.administration(account, company)
      return
  }

  // invoice / creditNote / purchases need a finalized invoice.
  const draft = await scenario.quoteToInvoice(customer, service)
  const invoice = await scenario.invoiceLifecycle(company, customer, subscription, draft)

  switch (phase) {
    case 'invoice':
      return
    case 'creditNote':
      await scenario.creditNote(customer, invoice, service)
      return
    case 'purchases':
      await scenario.purchases()
      return
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void route(req, res).catch((err) => {
    log.warn(`unhandled: ${describeError(err)}`)
    if (!res.headersSent) json(res, 500, { error: describeError(err) })
  })
})

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // Health + index.
  if (method === 'GET' && path === '/') {
    json(res, 200, {
      service: 'facturino-demo-node-sdk',
      baseUrl: config.baseUrl,
      routes: {
        'POST /run': 'full A→J scenario',
        'POST /run/:phase': `one phase (${PHASES.join(', ')})`,
        'POST /webhooks': 'inbound Facturino events (signature-verified)',
      },
    })
    return
  }

  // Inbound webhooks.
  if (method === 'POST' && path === '/webhooks') {
    await handleWebhook(req, res, facturino, config)
    return
  }

  // Full scenario.
  if (method === 'POST' && path === '/run') {
    const flags = readFlags()
    try {
      await runScenario(facturino, config, flags)
      json(res, 200, { ok: true })
    } catch (err) {
      log.warn(describeError(err))
      json(res, 502, { ok: false, error: describeError(err) })
    }
    return
  }

  // Single phase.
  if (method === 'POST' && path.startsWith('/run/')) {
    const phase = path.slice('/run/'.length) as Phase
    if (!PHASES.includes(phase)) {
      json(res, 404, { error: `unknown phase "${phase}"`, phases: PHASES })
      return
    }
    try {
      await runPhase(phase, readFlags())
      json(res, 200, { ok: true, phase })
    } catch (err) {
      log.warn(describeError(err))
      json(res, 502, { ok: false, phase, error: describeError(err) })
    }
    return
  }

  json(res, 404, { error: 'not found', path })
}

server.listen(config.port, () => {
  log.info(`facturino-demo-node-sdk listening on http://localhost:${config.port}`)
  log.info(`API base URL: ${config.baseUrl}`)
  log.info('POST /run to play the full scenario; POST /webhooks receives events.')
})
