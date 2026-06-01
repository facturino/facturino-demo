# Atelier Dupont — demo PHP (SDK Facturino)

A small B2B SaaS backend that bills end to end through the
[Facturino API](https://facturino.com/docs/api) using the official
[`facturino/facturino-php`](https://github.com/facturino/facturino-php) SDK.

It runs the shared scenario from [`../docs/SCENARIO.md`](../docs/SCENARIO.md)
(steps A→J): bootstrap, catalog & customer, quote→invoice, the full invoice
lifecycle, a recurring subscription, a credit note, received invoices,
webhooks, accounting/reporting and account administration.

No framework: a single front controller (`public/index.php`) on PHP's built-in
web server. The only runtime dependency is the SDK.

## Requirements

- PHP 8.1+ with `ext-curl` and `ext-json`
- A **test-mode** API key (`fac_test_…`) — the demo refuses `fac_live_` keys
- [Composer](https://getcomposer.org/) to install the SDK

## Install

The SDK is pulled straight from its public Git repository (see
`composer.json`, `repositories` → `vcs`):

```bash
composer install
```

Once the package is published to Packagist, the standard command works as-is
and you can drop the `repositories`/`dev-main` pin:

```bash
# composer require facturino/facturino-php:^1.0
```

## Configure

Configuration comes entirely from the environment. Copy the template at the
repo root and fill in your test credentials:

```bash
cp ../.env.example ../.env
# edit ../.env:
#   FACTURINO_API_KEY=fac_test_...
#   FACTURINO_BASE_URL=https://facturino.com/api/v1   # default
#   FACTURINO_WEBHOOK_SECRET=whsec_...                # from step H19
#   PUBLIC_BASE_URL=https://your-tunnel.example.com   # for webhooks
#   PORT=4242
```

`bootstrap.php` loads `../.env` (then an optional local `./.env`) without
overriding variables already exported in your shell.

> **Base URL note.** The SDK prepends `/v1` to every path
> (`Facturino\Resource\Invoice::BASE_PATH = "/v1/invoices"`). `.env.example`
> ships `FACTURINO_BASE_URL=…/api/v1`, so `Config::normalizeBaseUrl()` strips a
> trailing `/v1` before calling `Facturino::setApiBase()` — otherwise you'd hit
> `…/api/v1/v1/invoices`.

## Run

Start the HTTP server:

```bash
php -S localhost:4242 -t public public/index.php
```

Then drive the scenario:

```bash
# Whole journey A -> J
curl -s -X POST localhost:4242/run | jq

# A single phase (a..j)
curl -s -X POST localhost:4242/run/d | jq      # invoice lifecycle

# Fix the idempotency run id (stable retries)
curl -s -X POST 'localhost:4242/run?run_id=2026-05-31-demo' | jq

# Enable destructive ops (revoke key/member, schedule deletion, plan change)
curl -s -X POST 'localhost:4242/run/j?destructive=1' | jq
```

You can also run it straight from the CLI, no HTTP server:

```bash
php public/index.php          # whole journey
php public/index.php d        # one phase
ALLOW_DESTRUCTIVE=1 php public/index.php j
```

### Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Index: available routes & options |
| `GET` | `/health` | Liveness probe |
| `POST` | `/run` | Full journey A→J |
| `POST` | `/run/{a..j}` | One phase (prerequisites replayed automatically) |
| `POST` | `/webhooks` | Inbound Facturino webhooks (signature verified) |

### Webhooks

`POST /webhooks` reads the **raw** request body before any JSON parsing and
verifies it with the SDK helper
`\Facturino\Webhook::constructEvent($rawBody, $signatureHeader, $secret)`
(HMAC-SHA256 over `"<timestamp>.<rawBody>"`, timing-safe compare, ±300 s
replay window). To receive real events, expose the server with a tunnel
(`cloudflared`/`ngrok`), set `PUBLIC_BASE_URL`, run step H19
(`webhookEndpoints.create`), and copy the returned `whsec_…` secret into
`FACTURINO_WEBHOOK_SECRET`.

## Conventions

- **Amounts** in integer cents (`10000` = €100.00); **VAT** in integer
  hundredths of a percent (`2000` = 20.00%). No floats.
- **Idempotency-Key** on every create POST, stable per `(run id, step)` so a
  retry returns the existing resource instead of duplicating it
  (`src/Idempotency.php`).
- **Cursor pagination** via the SDK's auto-paginating `Collection`
  (`foreach (Invoice::all([...]) as $invoice)`).
- **Errors** surface the `request_id` (and `code`/`param`/`hint`) for support
  (`Console::describe()`), and the journey keeps going so you get a full report.
- **Determinism**: in `fac_test_` mode, `sandbox.simulateStatus` advances the
  PA lifecycle so the webhook chain fires without a real deposit.
- **Safety**: destructive/sensitive calls (`apiKeys.revoke`,
  `members.revoke`, `billing.updateSubscription`/`portal`,
  `account.scheduleDeletion`) are implemented but gated behind
  `?destructive=1`. `billing.checkout` (starts a real payment) and
  `account.scheduleDeletion` are additionally left commented or paired with an
  immediate cancel.

## Layout

```
04-php-sdk/
├── composer.json              # SDK via VCS repo + dev-main
├── public/index.php           # front controller / router (php -S target)
└── src/
    ├── bootstrap.php          # .env loader + autoload + SDK init
    ├── Config.php             # env reader + base-url normalization
    ├── Idempotency.php        # stable per-run idempotency keys
    ├── Console.php            # step journal + error formatting (request_id)
    ├── Scenario.php           # the A->J walkthrough
    └── WebhookController.php   # /webhooks signature verify + dispatch
```

## Coverage — step → SDK method

Every step maps to one or more SDK calls. The union covers all API families
listed in `docs/SCENARIO.md`.

| Step | What | SDK call(s) |
|---|---|---|
| **A1** | Who am I | `Account::retrieve()` |
| **A2** | Issuer company | `Company::all()`, `Company::retrieve()` |
| **A2b** | Invoicing settings | `Company::updateInvoicingSettings()` |
| **A2c** | Accounting & reminders | `Setting::retrieveAccounting/updateAccounting/retrieveReminders/updateReminders()` |
| **A3** | Connect PA (BYOPA) | `Company::connectPA()`, `Company::testPAConnection()` |
| **A3b** | INSEE reference data | `Reference::listLegalForms()`, `Reference::listNafCodes()` |
| **A4** | Quotas | `Usage::retrieve()` |
| **B5 / B5b** | Products | `Product::create()` (×2) |
| **B5c** | Product read/list | `Product::retrieve/update/all()` |
| **B5d** | Product CSV | `Product::importCsv()`, `Product::exportCsv()` |
| **B6** | SIRENE lookup | `Customer::lookup()` |
| **B6b** | Create customer | `Customer::create()` (idempotent) |
| **B6c** | Customer read/list | `Customer::retrieve/update/all()` |
| **B6d** | Customer CSV | `Customer::importCsv()`, `Customer::exportCsv()` |
| **C7** | Quote | `Quote::create()` |
| **C7b** | Send/read quote | `Quote::send()`, `Quote::retrieve()` |
| **C7c** | Accept + proof | `Quote::accept/getPdf/getSignatureProof()` |
| **C7d** | Convert to invoice | `Quote::convert()` |
| **C8** | Upstream validation | `Validate::run()` (EN16931) |
| **D9** | Create invoice | `Invoice::create()` (BG-7, BT-13) |
| **D9b** | Finalize | `Invoice::finalize/retrieve/getStatus()` |
| **D10** | Documents | `Invoice::getPdf/getFacturx/getXml()`, `Job::retrieve()` |
| **D11** | Deposit to PA | `Invoice::send()` |
| **D11b** | Force PA status | `Sandbox::simulateStatus()` |
| **D12** | Payment links | `Invoice::createPaymentLink/createPortalLink()` |
| **D12b** | Record payment | `Payment::create()`, `Payment::all()` |
| **D13** | Reminder/events | `Invoice::remind()`, `Invoice::listEvents()` |
| **D14** | Audit trail | `Invoice::verify/getAuditTrail/generateAuditTrailPdf()` |
| **D15** | Clone | `Invoice::clone()` |
| **E16** | Recurring | `RecurringInvoice::create()` |
| **E16b** | Recurring read/list | `RecurringInvoice::retrieve/update/all()` |
| **E16c** | Pause/resume | `RecurringInvoice::pause/resume()` |
| **F17** | Credit note | `CreditNote::create()` |
| **F17b** | Finalize/send/docs | `CreditNote::finalize/send/getPdf/getFacturx()` |
| **G18** | Incoming invoice | `Invoice::createIncoming()`, `Invoice::listIncoming()` |
| **G18b** | Received invoices | `ReceivedInvoice::all/retrieve/approve/recordPayment()` (refuse/suspend documented) |
| **H19** | Webhook endpoint | `WebhookEndpoint::create/all/test()` |
| **H20** | Receive | `Webhook::constructEvent()` (see `WebhookController`) |
| **H21** | Replay | `Event::all/retrieve/retry()` |
| **I22** | Reporting | `Reporting::vat()`, `Reporting::revenue()` |
| **I23** | Exports | `Export::generateFec/getFecStatus/exportInvoices/exportRgpd/getExportStatus()` |
| **I24** | E-reporting | `Ereporting::createDeclaration/retrieve/submitDeclaration/all()` |
| **I25** | Archives | `\Facturino\Resource\Archive::all/retrieve()` |
| **I26** | Notifications | `Notification::all/markRead/markAllRead/retrievePreferences/updatePreferences()` |
| **J27** | API keys | `ApiKey::create/retrieve/roll/all()` (`revoke()` gated) |
| **J28** | Members | `Member::invite/retrieve/updateRole/resendInvitation/all()` (`revoke()` gated) |
| **J29** | Facturino billing | `Billing::retrieveSubscription/listInvoices/getInvoicePdf()` (`updateSubscription/portal/checkout/pause/resume` gated) |
| **J30** | RGPD | `Account::requestExport/downloadExport/updateNotifications()` (`scheduleDeletion/cancelDeletion` gated) |
| **J-cabinets** | Cabinets (illustrative) | `Cabinet::all()` (requires `cabinet_*` plan) |

> **MFA** (`Mfa::*`) is part of the SDK but belongs to the web app flow, not a
> typical SaaS-API integration, so it is documented but not exercised here.
