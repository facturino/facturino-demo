# 05 — No SDK (raw HTTP, TypeScript)

The reference demo. It runs the shared **Atelier Dupont** scenario
([`../docs/SCENARIO.md`](../docs/SCENARIO.md)) against the Facturino API using
nothing but the platform: `fetch`, `node:http`, and `node:crypto`. **Zero
runtime dependencies.**

Where the other demos call an SDK method, this one issues the HTTP request by
hand. Read it to understand exactly what an SDK does for you under the hood:

| Concern | Where it lives | What it does |
|---|---|---|
| Bearer auth | `src/client.ts` | `Authorization: Bearer fac_test_…` on every request |
| Idempotency | `src/client.ts` | `Idempotency-Key` on creation POSTs; deterministic per logical op so re-runs don't duplicate |
| Retry / backoff | `src/client.ts` | retries `429` / `5xx`, honours `Retry-After`, exponential backoff + jitter |
| Error decoding | `src/client.ts` | parses `{ error: { type, code, message, … request_id } }`, surfaces `request_id` |
| Cursor pagination | `src/client.ts` | `list()` / `listAll()` follow `has_more` + `next_cursor` (`starting_after`) |
| Webhook signature | `src/webhook.ts` | reads the **raw body**, recomputes `HMAC-SHA256(secret, "${t}.${raw}")`, timing-safe compare, replay window |
| HTTP server | `src/server.ts` | `POST /run`, `POST /webhooks`, `GET /health` on `node:http` |
| Scenario | `src/scenario.ts` | the A→J parcours, one method per phase |

## Prerequisites

- **Node 20+** (uses the global `fetch`, `node:` imports, and top-level
  `URL`). Built and verified on Node 20 and 22.
- A **test-mode** API key (`fac_test_…`). The demo refuses a `fac_live_` key.

> This demo has no SDK dependency, so there is nothing to install from a
> registry. The other four demos pull a Facturino SDK from its public Git
> repo (and, once published, the standard registry command:
> `npm install @facturino/node`, `pip install facturino`,
> `composer require facturino/facturino-php`, `go get …`). Here, the
> `dependencies` block in `package.json` is intentionally empty.

## Install

```bash
npm install        # installs only devDependencies: typescript + @types/node
npm run build      # tsc → dist/
```

## Configure

Copy the repo-root template and fill in your test credentials:

```bash
cp ../.env.example .env
# edit .env:
#   FACTURINO_API_KEY=fac_test_…
#   FACTURINO_BASE_URL=https://facturino.com/api/v1   (or your local emulator)
#   FACTURINO_WEBHOOK_SECRET=whsec_…                  (from webhookEndpoints.create)
#   PUBLIC_BASE_URL=https://<your-tunnel>             (so Facturino can reach /webhooks)
#   PORT=4242
```

There is no dotenv dependency. Load `.env` with Node's built-in flag:

```bash
node --env-file=.env dist/server.js
```

(Or `export` the variables in your shell.)

## Run

```bash
npm run build
node --env-file=.env dist/server.js
```

Then, in another terminal:

```bash
# Run the whole A→J scenario against the API
curl -X POST http://localhost:4242/run

# Liveness + config sanity check
curl http://localhost:4242/health
```

Facturino will `POST` events to `PUBLIC_BASE_URL/webhooks`. Locally, expose the
port with a tunnel (cloudflared / ngrok) and paste the HTTPS URL into
`PUBLIC_BASE_URL` so `webhookEndpoints.create` registers a reachable target.

### Destructive / billing-real operations

Some scenario calls would change a real account or send real mail
(`account.scheduleDeletion`, `billing.checkout`/`updateSubscription`,
`members.invite`/`revoke`, `apiKeys.revoke`, `ereporting.submit`, …). They are
**coded** but **guarded**: they only fire when you opt in with

```bash
ALLOW_DESTRUCTIVE=1 node --env-file=.env dist/server.js
```

Without the flag, each one logs a `⚠` line explaining what was skipped.

### Determinism in test mode

To avoid waiting on a real PA deposit, the demo uses
`sandbox.simulateStatus` (test mode only) to walk an invoice through the PA
status machine (`deposited → transmitted → available → received → approved`),
which is what drives the webhook chain.

## Conventions

- **Amounts**: integer **cents** — `unitPrice: 10000` = €100.00.
- **VAT rates**: integer **hundredths of a percent** — `vatRate: 2000` = 20.00%.
- **Quantities**: decimal strings — `quantity: "2.5"`.
- No floating point, anywhere.

## Step → HTTP request correspondence

The scenario lettering matches [`../docs/SCENARIO.md`](../docs/SCENARIO.md).
Every row is a real request issued by `src/scenario.ts`.

### A. Bootstrap

| Step | Operation | HTTP request |
|---|---|---|
| A.1 | account.retrieve | `GET /account` |
| A.2 | companies.list / get | `GET /companies` · `GET /companies/{id}` |
| A.2 | companies.updateInvoicingSettings | `PATCH /companies/{id}/invoicing-settings` |
| A.2 | settings.retrieve/updateAccounting | `GET`/`PATCH /companies/{id}/settings/accounting` |
| A.2 | settings.retrieve/updateReminders | `GET`/`PATCH /companies/{id}/settings/reminders` |
| A.3 | reference.listLegalForms / listNafCodes | `GET /reference/legal-forms` · `GET /reference/naf-codes` |
| A.3 | companies.connectPA / testPAConnection | `POST /companies/{id}/pa-connection` · `POST /companies/{id}/pa-connection/test` |
| A.4 | usage.retrieve | `GET /usage` |

### B. Catalogue & client

| Step | Operation | HTTP request |
|---|---|---|
| B.5 | products.create | `POST /products` |
| B.5 | products.list / get / update | `GET /products` · `GET /products/{id}` · `PATCH /products/{id}` |
| B.5 | products.exportCsv / importCsv | `GET /products/export` · `POST /products/import` |
| B.6 | customers.lookup | `POST /customers/lookup` |
| B.6 | customers.create / get / update / list | `POST /customers` · `GET /customers/{id}` · `PATCH /customers/{id}` · `GET /customers` |
| B.6 | customers.exportCsv / importCsv | `GET /customers/export` · `POST /customers/import` |

### C. Devis → facture

| Step | Operation | HTTP request |
|---|---|---|
| C.7 | quotes.create / send / get / accept | `POST /quotes` · `POST /quotes/{id}/send` · `GET /quotes/{id}` · `POST /quotes/{id}/accept` |
| C.7 | quotes.getPdf / getSignatureProof | `GET /quotes/{id}/pdf` · `GET /quotes/{id}/signature-proof` |
| C.7 | quotes.convert | `POST /quotes/{id}/convert` |
| C.8 | validate.run | `POST /validate` |

### D. Cycle de vie facture

| Step | Operation | HTTP request |
|---|---|---|
| D.9 | invoices.create / finalize / get / getStatus | `POST /invoices` · `POST /invoices/{id}/finalize` · `GET /invoices/{id}` · `GET /invoices/{id}/status` |
| D.10 | invoices.getPdf / getFacturx / getXml | `GET /invoices/{id}/pdf` · `GET /invoices/{id}/facturx` · `GET /invoices/{id}/xml?format=cii|ubl` |
| D.10 | jobs.poll | `GET /jobs/{id}` |
| D.11 | invoices.send (dépôt PA) | `POST /invoices/{id}/send` |
| — | sandbox.simulateStatus (test mode) | `POST /sandbox/simulate-status/{id}` |
| D.12 | invoices.createPaymentLink / createPortalLink | `POST /invoices/{id}/payment-link` · `POST /invoices/{id}/portal-link` |
| D.12 | payments.create / list | `POST /invoices/{id}/payments` · `GET /invoices/{id}/payments` |
| D.13 | invoices.remind / listEvents | `POST /invoices/{id}/remind` · `GET /invoices/{id}/events` |
| D.14 | invoices.verify / getAuditTrail / generateAuditTrailPdf | `GET /invoices/{id}/verify` · `GET /invoices/{id}/audit-trail` · `POST /invoices/{id}/audit-trail/pdf` |
| D.15 | invoices.clone | `POST /invoices/{id}/clone` |

### E. Abonnement récurrent

| Step | Operation | HTTP request |
|---|---|---|
| E.16 | recurringInvoices.create / list / get / update | `POST /recurring-invoices` · `GET /recurring-invoices` · `GET`/`PATCH /recurring-invoices/{id}` |
| E.16 | recurringInvoices.pause / resume | `POST /recurring-invoices/{id}/pause` · `POST /recurring-invoices/{id}/resume` |

### F. Avoir

| Step | Operation | HTTP request |
|---|---|---|
| F.17 | creditNotes.create / finalize / send | `POST /credit-notes` · `POST /credit-notes/{id}/finalize` · `POST /credit-notes/{id}/send` |
| F.17 | creditNotes.getPdf / getFacturx | `GET /credit-notes/{id}/pdf` · `GET /credit-notes/{id}/facturx` |

### G. Achats (factures reçues)

| Step | Operation | HTTP request |
|---|---|---|
| G.18 | invoices.createIncoming / listIncoming | `POST /invoices/incoming` · `GET /invoices/incoming` |
| G.18 | receivedInvoices.list / get | `GET /received-invoices` · `GET /received-invoices/{id}` |
| G.18 | receivedInvoices.approve / refuse† / suspend† | `POST /received-invoices/{id}/approve` · `…/refuse` · `…/suspend` |
| G.18 | receivedInvoices.recordPayment | `POST /received-invoices/{id}/record-payment` |

### H. Webhooks

| Step | Operation | HTTP request |
|---|---|---|
| H.19 | webhookEndpoints.list / create / test | `GET /webhook-endpoints` · `POST /webhook-endpoints` · `POST /webhook-endpoints/{id}/test` |
| H.20 | webhooks reception | `POST /webhooks` (this server — verified in `src/webhook.ts`) |
| H.21 | events.list / get / retry | `GET /events` · `GET /events/{id}` · `POST /events/{id}/retry` |

### I. Comptabilité & pilotage

| Step | Operation | HTTP request |
|---|---|---|
| I.22 | reporting.vatReport / revenueReport | `GET /reporting/vat` · `GET /reporting/revenue` |
| I.23 | exports.generateFec / getFecStatus | `POST /exports/fec` · `GET /exports/fec/{id}` |
| I.23 | exports.exportInvoices | `POST /exports/invoices` |
| I.23 | exports.exportRgpd / getExportStatus | `POST /exports/full` · `GET /exports/{id}` |
| I.24 | ereporting.createDeclaration / list / get / submit† | `POST /ereporting/declarations` · `GET /ereporting/declarations` · `GET /…/{id}` · `POST /…/{id}/submit` |
| I.25 | archives.list / get | `GET /archives` · `GET /archives/{invoiceId}` |
| I.26 | notifications.list / markRead / markAllRead | `GET /notifications` · `PATCH /notifications/{id}` · `PATCH /notifications/mark-all-read` |
| I.26 | notifications.retrieve/updatePreferences | `GET`/`PATCH /notification-preferences` |

### J. Administration du compte

| Step | Operation | HTTP request |
|---|---|---|
| J.27 | apiKeys.create / list / get / roll / revoke† | `POST /api-keys` · `GET /api-keys` · `GET /api-keys/{id}` · `POST /api-keys/{id}/roll` · `DELETE /api-keys/{id}` |
| J.28 | members.invite† / list / get / updateRole† / resend† / revoke† | `POST /companies/{id}/members` · `GET /companies/{id}/members` · `GET`/`PATCH /…/{memberId}` · `POST /…/{memberId}/resend-invitation` · `DELETE /…/{memberId}` |
| J.29 | billing.retrieveSubscription / listInvoices / getInvoicePdf | `GET /billing/subscription` · `GET /billing/invoices` · `GET /billing/invoices/{id}/pdf` |
| J.29 | billing.updateSubscription† / pause† / resume† / checkout† / portal† | `PATCH /billing/subscription` · `POST /billing/pause` · `…/resume` · `…/checkout` · `…/portal` |
| J.30 | account.requestExport / downloadExport | `POST /account/export` · `GET /account/exports/{id}/download` |
| J.30 | account.updateNotifications | `PATCH /account/notifications` |
| J.30 | account.scheduleDeletion† / cancelDeletion† | `POST /account/schedule-deletion` · `POST /account/cancel-deletion` |
| — | cabinets.list (illustratif, plan cabinet) | `GET /cabinets` |
| — | mfa.* (app web, hors API SaaS) | documenté, non exécuté |

> **†** = guarded behind `ALLOW_DESTRUCTIVE=1` (changes a real account, sends
> real mail, or transmits to the DGFiP). Coded, but skipped by default.

## What's covered

API families touched by the parcours (union of all steps):

`account · apiKeys · archives · billing · cabinets · companies · creditNotes ·
customers · ereporting · events · exports · invoices · jobs · members ·
notifications · payments · products · quotes · receivedInvoices ·
recurringInvoices · reference · reporting · sandbox · settings · usage ·
validate · webhookEndpoints · webhooks (reception)`

`mfa` is documented only (web-app concern). `cabinets` is an illustrative
plan-gated call.
