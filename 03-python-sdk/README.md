# Atelier Dupont — Facturino demo (Python SDK)

A minimal SaaS backend whose billing runs **entirely on Facturino**, built
with the official [`facturino`](https://github.com/facturino/facturino-python)
Python SDK and a small Flask server.

*Atelier Dupont SAS* is a B2B studio that sells one-off services and a monthly
subscription. This demo walks the full lifecycle — from "who am I" through
quote → invoice → PA deposit → payment → recurring billing → credit note →
purchases → reporting/FEC → account administration — and receives Facturino
**webhooks** on a signed endpoint.

It is the Python member of a five-stack demo set; every stack implements the
same scenario described in [`../docs/SCENARIO.md`](../docs/SCENARIO.md).

---

## Prerequisites

- Python 3.10+ (the published SDK's minimum)
- A Facturino **test-mode** API key (`fac_test_…`)
- For live webhook delivery: a public tunnel (e.g. `cloudflared`, `ngrok`)
  pointing at this server's `/webhooks` route

## Install

```bash
cd 03-python-sdk
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` installs the SDK from PyPI:

```text
facturino>=1.0
flask>=3.0
```

## Configure

All configuration comes from the environment. Copy the repo-level template and
fill in your test credentials:

```bash
cp ../.env.example .env
# then edit .env
```

| Variable                   | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `FACTURINO_API_KEY`        | Test-mode key (`fac_test_…`). Never commit a real key.             |
| `FACTURINO_BASE_URL`       | API base URL. Default `https://facturino.com/api/v1`.              |
| `FACTURINO_WEBHOOK_SECRET` | Endpoint signing secret (`whsec_…`) from `webhookEndpoints.create`.|
| `PUBLIC_BASE_URL`          | Public HTTPS URL where Facturino can reach `/webhooks`.            |
| `PORT`                     | Local HTTP port (default `4242`).                                  |

> **Base-URL note.** The SDK methods already prefix every path with `/v1`, and
> the SDK's own default base is `https://facturino.com/api`. The shared
> `.env.example` ships the explicit `…/api/v1` form, so `config.py` strips a
> trailing `/v1` before constructing the client to avoid a doubled
> `/api/v1/v1/…`. Point `FACTURINO_BASE_URL` at your local emulator when
> developing offline.

## Run

```bash
# load .env into the environment, then start the server
set -a && source .env && set +a
python -m atelier_dupont
# equivalently:  flask --app atelier_dupont.app run --port "$PORT"
```

Then drive it:

```bash
# Run the entire A→J journey and get a structured report
curl -X POST http://localhost:4242/run | python -m json.tool

# Run a single phase (a..j) — prerequisites are bootstrapped automatically
curl -X POST http://localhost:4242/run/d | python -m json.tool

# Index of routes + phase list
curl http://localhost:4242/
```

Webhooks arrive on `POST /webhooks`: the route reads the **raw** body, verifies
the `Facturino-Signature` header with `facturino.Webhook.construct_event`
(HMAC-SHA256 over `{timestamp}.{body}`, constant-time compare, 5-minute replay
window), then dispatches by event type. Register the endpoint from the scenario
(phase H) or in the dashboard, and set `FACTURINO_WEBHOOK_SECRET` to the secret
returned at creation time.

### Scope

This demo exercises the invoicing lifecycle end to end (customers, products,
invoices, quotes, credit notes, recurring, e-reporting, exports, billing read,
RGPD export) against a **test-mode** key. It performs **no destructive
operations**: account deletion, subscription changes and key/member management
are managed in the Facturino web app, not the developer API — so a demo run
never charges a card or mutates your account.

---

## Project layout

```
03-python-sdk/
├── atelier_dupont/
│   ├── __init__.py      # package + app factory re-export
│   ├── __main__.py      # `python -m atelier_dupont`
│   ├── config.py        # env loading + client factory (base-URL normalization)
│   ├── helpers.py       # idempotency keys, error formatting, job polling
│   ├── scenario.py      # the A→J journey (one function per phase)
│   ├── webhooks.py      # signature verification + event dispatch
│   └── app.py           # Flask server (routes)
├── requirements.txt
└── README.md
```

## Conventions demonstrated

- **Amounts** in integer centimes (`10000` = 100.00 €); **VAT** in centipercent
  (`2000` = 20.00 %). No floats anywhere.
- **Idempotency-Key** on every creation, derived deterministically per step so
  re-running the scenario is a replay, not a duplicate (`helpers.idempotency_key`).
- **Cursor pagination**: list endpoints return SDK pages that auto-follow
  `has_more`; the demo iterates them directly.
- **Filters & expansion**: list filters (`products.list(q=…, active=…)`,
  `invoices.list(convertedFrom="quo_…")`) and field expansion
  (`invoices.get(id, expand="credit_notes")`) pass straight through as query
  params — the SDK is a thin pass-through over `/v1`.
- **Error handling**: API errors are rendered with their `request_id` (quote it
  to Facturino support) via `helpers.describe_error`.
- **Lookup-or-create**: the customer and webhook endpoint are reused if they
  already exist, so the journey is safely repeatable.
- **Async jobs**: PDF / Factur-X / FEC responses that return `202 + jobId` are
  polled to completion with `helpers.poll_job` (built on `jobs.get`).

---

## Coverage — scenario step → SDK method

| Step | Scenario action | SDK method(s) |
| ---- | --------------- | ------------- |
| A1 | Who am I (key, plan, livemode) | `account.retrieve` |
| A2 | Emitting company | `companies.list`, `companies.get`, `companies.create` |
| A2b | Terms (CGV) + onboarding milestone | `companies.upload_cgv` / `get_cgv` / `delete_cgv`, `companies.add_milestone` |
| A3 | Reference tables | `reference.list_legal_forms`, `reference.list_naf_codes` |
| A4 | Quota usage | `usage.retrieve` |
| B5 | Products (subscription + service) | `products.create`, `products.list` (incl. filters `q` / `category` / `active`), `products.get`, `products.update`, `products.import_csv`, `products.export_csv` |
| B6 | Customer (SIRENE lookup, CRUD) | `customers.lookup`, `customers.create` (with a `role: billing` contact), `customers.get`, `customers.update`, `customers.list`, `customers.export_csv` |
| C7 | Quote lifecycle | `quotes.create`, `quotes.send`, `quotes.get`, `quotes.accept`, `quotes.get_pdf`, `quotes.get_signature_proof`, `quotes.clone`, `quotes.convert` |
| C8 | Upfront EN16931 validation | `validate.run` |
| D9 | Create / finalize invoice | `invoices.create`, `invoices.get`, `invoices.finalize`, `invoices.get_status`, `invoices.list` (filter `convertedFrom`) |
| D10 | Documents (PDF / Factur-X / XML) | `invoices.get_pdf`, `invoices.get_facturx`, `invoices.get_xml`, `jobs.get` (poll) |
| D11 | PA deposit | `invoices.send` |
| D12 | Collection | `invoices.create_payment_link`, `invoices.create_portal_link`, `invoices.create_payment_token`, `payments.create`, `payments.list` |
| D13 | Reminder & events | `invoices.remind`, `invoices.list_events` |
| D14 | Audit trail | `invoices.verify`, `invoices.get_audit_trail`, `invoices.generate_audit_trail_pdf` |
| D15 | Clone | `invoices.clone` |
| E16 | Recurring subscription | `recurring_invoices.create`, `recurring_invoices.list`, `recurring_invoices.get`, `recurring_invoices.update`, `recurring_invoices.pause`, `recurring_invoices.resume` |
| F17 | Credit note | `credit_notes.create`, `credit_notes.finalize`, `credit_notes.send`, `credit_notes.get_pdf`, `credit_notes.get_facturx`, `invoices.get` (`expand=credit_notes` → linked credit notes + net balance) |
| G18 | Purchases (received invoices) | `invoices.create_incoming`, `invoices.list_incoming`, `received_invoices.list`, `received_invoices.retrieve`, `received_invoices.approve`, `received_invoices.refuse`*, `received_invoices.suspend`*, `received_invoices.record_payment` |
| H19 | Webhook endpoint registration | `webhook_endpoints.create`, `webhook_endpoints.list`, `webhook_endpoints.get` |
| H20 | Test + reception | `webhook_endpoints.test`, `Webhook.construct_event` (in `/webhooks`) |
| H21 | Event replay | `events.list`, `events.get`, `events.retry` |
| I22 | Reporting | `reporting.vat`, `reporting.revenue` |
| I23 | Exports | `exports.generate_fec`, `exports.get_fec_status`, `exports.export_invoices` |
| I24 | E-reporting | `ereporting.create_declaration`, `ereporting.list`, `ereporting.get`, `ereporting.submit_declaration` |
| I25 | Archives | `archives.list`, `archives.get` |
| J29 | Facturino billing (read-only) | `billing.retrieve_subscription`, `billing.list_invoices`, `billing.get_invoice_pdf` |
| J30 | RGPD | `account.request_export`, `account.download_export` |
| — | Determinism (test mode) | `sandbox.simulate_status` |

> API keys, team members and subscription changes are managed in the Facturino
> web app, not over the developer API, so they are not part of the SDK.

### API families covered

`account` · `archives` · `billing` · `companies` · `creditNotes` ·
`customers` · `ereporting` · `events` · `exports` · `invoices` · `jobs` ·
`payments` · `products` · `quotes` · `receivedInvoices` ·
`recurringInvoices` · `reference` · `reporting` · `sandbox` · `usage` ·
`validate` · `webhookEndpoints` · `webhooks` (reception).
