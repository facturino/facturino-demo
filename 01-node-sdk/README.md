# Facturino demo — Node.js / TypeScript SDK

"Atelier Dupont", a French B2B SaaS that bills **100% through Facturino**, from
the first quote to the accounting export. This demo runs the shared scenario
(see [`../docs/SCENARIO.md`](../docs/SCENARIO.md), steps A→J) using the official
[`@facturino/node`](https://github.com/facturino/facturino-node) SDK.

It is a small executable backend: an HTTP server whose routes trigger scenario
steps, plus a `/webhooks` endpoint that verifies inbound event signatures.

## Requirements

- Node.js 20+ (uses native `fetch`, `node:http`, `node:crypto`).
- A **test-mode** API key (`fac_test_…`). The server refuses any other key.
- For webhooks: a public HTTPS tunnel (cloudflared / ngrok) so Facturino can
  reach `/webhooks`.

## Install

The SDK comes from the npm registry (see `package.json`):

```jsonc
"dependencies": {
  "@facturino/node": "^1.0.0"
}
```

```bash
npm install
```

> **Offline typecheck.** If you have a sibling checkout of the SDK and cannot
> install from Git, uncomment the `baseUrl` / `paths` block in `tsconfig.json`
> to resolve `@facturino/node` against `../../facturino-node/dist/esm`.

## Configure

```bash
cp ../.env.example .env
# Fill in:
#   FACTURINO_API_KEY        fac_test_…   (required)
#   FACTURINO_BASE_URL       https://facturino.com/api/v1   (default)
#   FACTURINO_WEBHOOK_SECRET whsec_…      (printed by webhookEndpoints.create)
#   PUBLIC_BASE_URL          https://<your-tunnel>          (for /webhooks)
#   PORT                     4242
```

## Run

```bash
npm run build      # tsc → dist/
npm start          # node dist/server.js   (loads .env if you export it)

# Or, dev mode with TS executed directly:
node --env-file=.env --watch --experimental-strip-types src/server.ts
```

Then drive the scenario over HTTP:

```bash
curl -X POST http://localhost:4242/run                # full A→J scenario
curl -X POST http://localhost:4242/run/bootstrap      # a single phase
curl http://localhost:4242/                           # route index
```

Phase routes: `bootstrap`, `catalogue`, `customer`, `quote`, `validate`,
`invoice`, `recurring`, `creditNote`, `purchases`, `webhooks`, `accounting`,
`administration`. Phases that depend on earlier resources
rebuild their (idempotent) prerequisites first, so any phase runs standalone.

### Webhooks

1. Expose the server with a tunnel and put the HTTPS URL in `PUBLIC_BASE_URL`.
2. `POST /run/webhooks` registers `…/webhooks` via `webhookEndpoints.create`
   and prints the signing secret. Put it in `FACTURINO_WEBHOOK_SECRET` and
   restart, or pass it through your process manager.
3. `/webhooks` reads the **raw** body, verifies the `Facturino-Signature`
   header with `facturino.webhooks.constructEvent(rawBody, header, secret)`,
   then dispatches the event.

### Conventions used

- **Amounts** in integer cents (`9900` = €99.00), **VAT** in centipercent
  (`2000` = 20.00%). No floating point.
- **Idempotency-Key** on every creating POST, derived from a stable scope so a
  replay reuses the same key (`src/lib.ts → idempotencyKey`).
- **Cursor pagination** via the SDK's auto-paginating lists (`list({ limit })`,
  follow `has_more` / `next_cursor`).
- **Errors** always surface `request_id` for support
  (`src/lib.ts → describeError`).
- **Determinism** in test mode: PA status transitions are forced with
  `sandbox.simulateStatus` so the webhook chain fires without a real PA.
- **No destructive operations.** The demo never deletes the account, mutates
  the Stripe subscription, or revokes keys/members — those surfaces are not part
  of the developer API. It exercises the invoicing lifecycle end to end only,
  using test-mode data.

## Files

| File | Role |
|------|------|
| `src/config.ts` | Reads the environment; constructs the `Facturino` client. |
| `src/lib.ts` | Idempotency keys, error formatting, date helpers, logging. |
| `src/scenario.ts` | The A→J scenario, one method per phase. |
| `src/webhook.ts` | `/webhooks` handler — signature verification + dispatch. |
| `src/server.ts` | HTTP server wiring routes to phases. |

## Scenario step → SDK method

| Step | What it does | SDK method(s) |
|------|--------------|---------------|
| **A.1** | Who am I (key, plan, livemode) | `account.retrieve` |
| **A.2** | Issuing company + INSEE reference data | `companies.list`, `companies.get`, `reference.listLegalForms`, `reference.listNafCodes` |
| **A.4** | Quotas vs plan limits | `usage.retrieve` |
| **B.5** | Products (subscription + service), CSV | `products.create`, `products.get`, `products.update`, `products.list` (filters `q`, `category`, `active`), `products.exportCsv` |
| **B.6** | Customer (SIRENE lookup, lookup-or-create, `billing` contact) | `customers.lookup`, `customers.list`, `customers.create` (`contacts: [{ role: 'billing' }]`), `customers.get`, `customers.update` |
| **C.7** | Quote → invoice | `quotes.create`, `quotes.send`, `quotes.get`, `quotes.accept`, `quotes.getPdf`, `quotes.getSignatureProof`, `quotes.clone`, `quotes.convert` |
| **C.8** | Upstream EN16931 validation (invoice dry-run) | `validate.run` (invoice payload) |
| **D.9** | Create + finalize + trace from quote | `invoices.create`, `invoices.finalize`, `invoices.get`, `invoices.getStatus`, `invoices.list` (filter `convertedFrom`) |
| **D.10** | Documents (PDF, Factur-X, CII+UBL) | `invoices.getPdf`, `invoices.getFacturx`, `invoices.getXml`, `jobs.poll` |
| **D.11** | Deposit to PA (+ deterministic status chain) | `invoices.send`, `sandbox.simulateStatus` |
| **D.12** | Collection | `invoices.createPaymentLink`, `invoices.createPortalLink`, `invoices.payments.create`, `invoices.payments.list` |
| **D.13** | Reminder + lifecycle | `invoices.remind`, `invoices.listEvents` |
| **D.14** | Audit trail | `invoices.verify`, `invoices.getAuditTrail`, `invoices.generateAuditTrailPdf` |
| **D.15** | Clone | `invoices.clone`, `invoices.del` |
| **E.16** | Recurring subscription | `recurringInvoices.create`, `recurringInvoices.get`, `recurringInvoices.update`, `recurringInvoices.pause`, `recurringInvoices.resume`, `recurringInvoices.list` |
| **F.17** | Credit note (+ invoice with credit notes expanded) | `creditNotes.create`, `creditNotes.finalize`, `creditNotes.send`, `creditNotes.getPdf`, `creditNotes.getFacturx`, `invoices.get` (`expand: ['credit_notes']` → `expanded.credit_notes`, `expanded.net_balance`) |
| **G.18** | Purchases / received invoices | `invoices.createIncoming`, `invoices.listIncoming`, `receivedInvoices.list`, `receivedInvoices.get`, `receivedInvoices.approve`, `receivedInvoices.recordPayment` (`refuse`/`suspend` coded) |
| **H.19** | Register + test webhook endpoint | `webhookEndpoints.list`, `webhookEndpoints.create`, `webhookEndpoints.test` |
| **H.20** | Receive + verify events | `webhooks.constructEvent` (in `src/webhook.ts`) |
| **H.21** | Event log / replay | `events.list`, `events.get`, `events.retry` |
| **I.22** | Reporting | `reporting.vatReport`, `reporting.revenueReport` |
| **I.23** | Exports | `exports.generateFec`, `exports.getFecStatus`, `exports.exportInvoices`, `exports.getExportStatus` |
| **I.24** | E-reporting | `ereporting.createDeclaration`, `ereporting.get`, `ereporting.submitDeclaration`, `ereporting.list` |
| **I.25** | Archives | `archives.list`, `archives.get` |
| **J.29** | Facturino billing (read-only) | `billing.retrieveSubscription`, `billing.listInvoices`, `billing.getInvoicePdf` |
| **J.30** | RGPD | `account.requestExport`, `account.downloadExport` |

> API keys, team members and subscription changes are managed in the Facturino
> web app, not over the developer API, so they are not part of the SDK.
