# Facturino — Demos

Five small backend apps that run the **same B2B SaaS scenario** against the
Facturino API, each in a different stack. They show how a French SaaS bills its
customers end to end — quotes, invoices, e-invoicing deposit to the PA,
payments, subscriptions, credit notes, webhooks and accounting exports.

The shared storyline lives in [`docs/SCENARIO.md`](docs/SCENARIO.md). Read it
first: every demo follows the same steps, so you can compare stacks line by
line.

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

> **Installing the SDK.** All four SDKs are published. The manifests resolve
> them through npm, PyPI, Packagist, or the Go module proxy. Standard install
> commands (`npm install @facturino/node`, `pip install facturino`, `composer
> require facturino/facturino-php`, `go get …`) work directly; each stack README
> documents its pinned range.

## Amounts and rates

Prices are integer **cents** (`10000` = €100.00). VAT rates are integer
**hundredths of a percent** (`2000` = 20.00%). No floating point, ever.

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
