# Facturino — Demos

Five small backend apps that run the **same B2B SaaS scenario** against the
Facturino API, each in a different stack. They show how a French SaaS bills its
customers end to end — quotes, invoices, e-invoicing deposit to the PA,
payments, subscriptions, credit notes, webhooks and accounting exports.

The shared storyline lives in [`docs/SCENARIO.md`](docs/SCENARIO.md). Read it
first: every demo follows the same steps, so you can compare stacks line by
line.

Phase **K** is the one to read if you collect money: it decides the VAT and the
exact amount to charge **before** anything is collected, carries the decision id
in the payment reference, verifies the settlement against the decision, then
issues the invoice from that decision and records the real collection.

Facturino imposes no payment service provider and no payment method. Phase K is
provider-neutral — a transfer, a direct debit, a cheque, cash, a wallet, an
external PSP or payment on terms all fit the same flow. Two PSP variants
(Stripe `metadata`, PayPal `custom_id`) are shown as optional examples, and both
are simulated locally: no payment service provider is ever contacted.

| # | Stack | Folder | Facturino SDK |
|---|-------|--------|---------------|
| 1 | Node.js / TypeScript | [`01-node-sdk`](01-node-sdk) | `@facturino/node` |
| 2 | Go | [`02-go-sdk`](02-go-sdk) | `github.com/facturino/facturino-go` |
| 3 | Python | [`03-python-sdk`](03-python-sdk) | `facturino` |
| 4 | PHP | [`04-php-sdk`](04-php-sdk) | `facturino/facturino-php` |
| 5 | Any language, no SDK | [`05-no-sdk`](05-no-sdk) | raw HTTP (`fetch`) |

The no-SDK demo is the reference: it implements auth, cursor pagination,
idempotency keys, retry/backoff and webhook signature verification by hand —
exactly what the SDKs do under the hood.

## Requirements

- A **test-mode** API key (`fac_test_…`). The demos never touch live data.
- Per stack: Node 20+, Go 1.21+, Python 3.10+, or PHP 8.1+.

## Setup

```bash
cp .env.example .env
# edit .env: FACTURINO_API_KEY, FACTURINO_BASE_URL, FACTURINO_WEBHOOK_SECRET
```

Then follow the README inside the demo you want to run. Each one starts a small
HTTP server: some routes trigger scenario steps, and `/webhooks` receives
Facturino events.

> **Installing the SDK.** The manifests resolve the SDKs through npm, PyPI,
> Packagist, or the Go module proxy. Standard install commands (`npm install
> @facturino/node`, `pip install facturino`, `composer require
> facturino/facturino-php`, `go get …`) work directly; each stack README
> documents its pinned range. The scenario needs the SDK major that carries
> the stable tax determination contract: `@facturino/node` 2.2.0, `facturino`
> (Python) 2.2.0, `facturino/facturino-php` 2.2.0 and
> `github.com/facturino/facturino-go/v2` v2.2.0.
>
> **Lockfiles.** The committed lockfiles (`package-lock.json`, `go.sum`,
> `composer.lock`) resolve the published 2.0.0 SDKs. A fresh install therefore
> reproduces the stable tax determination contract demonstrated here without
> any local SDK checkout or repository override.

## Amounts and rates

Prices are integer **cents** (`10000` = €100.00). VAT rates are integer
**hundredths of a percent** (`2000` = 20.00%). Quantities travel as decimal
**strings**. No floating point, ever.

## Scope

Facturino decides **French VAT and the matching French obligations**. It does
not provide worldwide tax compliance: when a foreign tax may apply, the decision
says so through `foreignTaxReviewRequired`, and that case must be reviewed
outside Facturino. An operation whose decided `invoiceChannel` is `none` is not
deposited on a certified platform — its obligation, if any, goes through
e-reporting, and the demos never attempt a deposit outside that channel.

## Layout

```
facturino-demo/
├── docs/SCENARIO.md     # the shared storyline, step by step
├── .env.example         # configuration template
├── 01-node-sdk/
├── 02-go-sdk/
├── 03-python-sdk/
├── 04-php-sdk/
└── 05-no-sdk/
```
