# Facturino demo — Go SDK

A small, runnable backend that bills the fictional **Atelier Dupont SAS** end
to end through the Facturino API, using the official Go SDK
(`github.com/facturino/facturino-go`). It walks the shared scenario described
in [`../docs/SCENARIO.md`](../docs/SCENARIO.md), phases **A through J**.

The app is a `net/http` server. Some routes trigger scenario phases; the
`/webhooks` route receives Facturino events and verifies their signature with
the SDK's webhook helper. It can also run the whole parcours once from the CLI.

## Requirements

- **Go 1.21+** (the module declares `go 1.21`; the SDK uses generics).
- A **test-mode** API key (`fac_test_…`). The demo refuses to start against a
  live key and never touches production data.

## Install the SDK dependency

The SDK is consumed from its public Git repository. Once it carries a published
semantic-version tag, the standard command resolves it over VCS:

```bash
go get github.com/facturino/facturino-go@v1.0.0
```

While developing inside this monorepo, `go.mod` keeps a `replace` directive
pointing the import at the sibling SDK checkout (`../../facturino-go`) so the
demo builds with no network round-trip. Remove that directive to build strictly
against the tagged release.

```bash
go mod tidy   # resolves dependencies (no-op extra deps: standard library only)
```

## Configure

Copy the repository-level template and fill in your test credentials:

```bash
cp ../.env.example .env
# edit .env:
#   FACTURINO_API_KEY=fac_test_...
#   FACTURINO_BASE_URL=https://facturino.com/api/v1   # or a local emulator
#   FACTURINO_WEBHOOK_SECRET=whsec_...                # from webhookEndpoints.create
#   PUBLIC_BASE_URL=https://your-tunnel.example.com   # reachable /webhooks origin
#   PORT=4242
```

Configuration is read from the process environment. The demo can also load a
`.env` file directly with the `-env` flag (existing env vars always win):

```bash
go run . -env .env
```

## Run

Start the HTTP server:

```bash
export $(grep -v '^#' .env | xargs)   # or: go run . -env .env
go run .
```

Then trigger the scenario:

```bash
# the whole parcours A..J
curl -X POST http://localhost:4242/run

# or one phase at a time
curl -X POST http://localhost:4242/run/bootstrap
curl -X POST http://localhost:4242/run/catalogue
curl -X POST http://localhost:4242/run/quote
curl -X POST http://localhost:4242/run/invoice
# ... see GET http://localhost:4242/ for the full route list

curl http://localhost:4242/state     # current scenario state snapshot
```

Run once from the CLI without starting the server:

```bash
go run . -run
```

### Receiving webhooks

`POST /webhooks` reads the raw request body, then calls the SDK helper
`facturino.VerifyWebhookSignature(body, header, secret)`. That helper parses the
`Facturino-Signature: t=…,v1=…` header, enforces the timestamp tolerance,
recomputes `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` and timing-safe
compares it before handing back the parsed event. Expose the server with a
tunnel (cloudflared / ngrok), put the HTTPS URL in `PUBLIC_BASE_URL`, and the
webhook phase registers `PUBLIC_BASE_URL + /webhooks` as the endpoint. Persist
the signing secret it returns into `FACTURINO_WEBHOOK_SECRET` so deliveries
verify.

### Destructive operations

Charge-incurring or account-altering calls are gated behind
`-allow-destructive` (off by default): Stripe checkout/portal, billing plan
change / pause / resume, and team-member role change / revoke.
`account.scheduleDeletion` / `cancelDeletion` are coded but **never auto-run** —
they are documented in `internal/scenario/steps_hij.go`.

```bash
go run . -run -allow-destructive   # only if you know what you are doing
```

## Conventions

- **Amounts** are integer **centimes** (`10000` = €100.00). **VAT rates** are
  integer **centipercent** (`2000` = 20.00 %). No floating point.
- **Idempotency-Key** on every POST creation, derived deterministically from a
  per-run seed so a retried request reuses the same server-side resource.
- **Pagination** uses the SDK's cursor iterators (`for it.Next()`), following
  `has_more` transparently.
- **Errors** surface the API `request_id` (see `explain` in
  `internal/scenario/scenario.go`) so a failure can be traced in support.
- The scenario is **re-runnable**: it looks customers up before creating them
  and reuses an existing draft when present.

## Layout

```
02-go-sdk/
├── go.mod                     # module + SDK dependency (VCS require + local replace)
├── main.go                    # CLI flags, server bootstrap, graceful shutdown
├── dotenv.go                  # minimal .env loader (no third-party dependency)
├── internal/
│   ├── config/config.go       # env -> Config -> facturino.New(...)
│   ├── scenario/              # the A..J parcours
│   │   ├── scenario.go        # Runner, state, error formatting, polling helpers
│   │   ├── log.go             # structured phase/step logger
│   │   ├── list.go            # decode the first item of a ListResponse
│   │   ├── steps_ab.go        # phases A, B
│   │   ├── steps_cd.go        # phases C, D
│   │   ├── steps_efg.go       # phases E, F, G
│   │   └── steps_hij.go       # phases H, I, J
│   └── server/server.go       # net/http routes + signed /webhooks receiver
└── README.md
```

## Step → SDK method mapping

The scenario steps map to SDK calls as follows. Service names are the fields on
`*facturino.Client` (for example `client.Invoices.Finalize`).

| Scenario step | SDK method(s) | Route |
|---|---|---|
| **A.1** Who am I | `Account.Retrieve` | `POST /run/bootstrap` |
| **A.2** Seller company | `Companies.List`, `Companies.Get`, `Companies.UpdateInvoicingSettings` | `POST /run/bootstrap` |
| **A.2** Accounting / reminders | `Settings.RetrieveAccounting` / `UpdateAccounting` / `RetrieveReminders` / `UpdateReminders` | `POST /run/bootstrap` |
| **A.3** PA connection (BYOPA) | `Companies.ConnectPA`, `Companies.TestPAConnection` | `POST /run/bootstrap` |
| **A.3** Reference tables | `Reference.ListLegalForms`, `Reference.ListNafCodes` | `POST /run/bootstrap` |
| **A.4** Quotas | `Usage.Retrieve` | `POST /run/bootstrap` |
| **B.5** Products | `Products.Create` / `Get` / `Update` / `List` (incl. `ProductListParams{Q, Category, Active}` filters) / `ExportCSV` | `POST /run/catalogue` |
| **B.6** Customer | `Customers.Lookup` / `Create` (with a `Contact{Role: "billing"}`) / `Get` / `Update` / `List` / `ExportCSV` | `POST /run/catalogue` |
| **C.7** Quote | `Quotes.Create` / `Send` / `Get` / `Accept` / `GetSignatureProof` / `GetPDF` / `Clone` / `Convert` | `POST /run/quote` |
| **C.8** Pre-flight validation | `Validate.Run` | `POST /run/quote` |
| **D.9** Create / finalize | `Invoices.Create` / `Finalize` / `Get` / `GetStatus` / `List` (`InvoiceListParams{ConvertedFrom}`) | `POST /run/invoice` |
| **D.10** Documents | `Invoices.GetPDF` / `GetFacturX` / `GetXML` (CII + UBL), `Jobs.Get` (poll) | `POST /run/invoice` |
| **D.11** Deposit to PA | `Invoices.Send`, `Sandbox.SimulateStatus` (determinism) | `POST /run/invoice` |
| **D.12** Payment | `Invoices.CreatePaymentLink` / `CreatePortalLink`, `Payments.Create` / `List` | `POST /run/invoice` |
| **D.13** Reminder & events | `Invoices.Remind`, `Invoices.ListEvents` | `POST /run/invoice` |
| **D.14** Audit trail | `Invoices.Verify`, `Invoices.GetAuditTrail`, `Invoices.GenerateAuditTrailPDF` | `POST /run/invoice` |
| **D.15** Clone | `Invoices.Clone` | `POST /run/invoice` |
| **E.16** Recurring | `RecurringInvoices.Create` / `Get` / `List` / `Update` / `Pause` / `Resume` | `POST /run/recurring` |
| **F.17** Credit note | `CreditNotes.Create` / `Finalize` / `Send` / `GetPDF` / `GetFacturX`, then `Invoices.Get` (`InvoiceGetParams{Expand: ["credit_notes"]}` → `Invoice.Expanded.CreditNotes` + `NetBalance`) | `POST /run/credit-note` |
| **G.18** Received invoices | `Invoices.CreateIncoming` / `ListIncoming`, `ReceivedInvoices.List` / `Get` / `Approve` / `Refuse`¹ / `Suspend`¹ / `RecordPayment` | `POST /run/received` |
| **H.19** Webhook endpoint | `WebhookEndpoints.Create` / `List` / `Test` | `POST /run/webhooks` |
| **H.20** Reception | `facturino.VerifyWebhookSignature` (in `internal/server`) | `POST /webhooks` |
| **H.21** Event replay | `Events.List` / `Get` / `Retry` | `POST /run/webhooks` |
| **I.22** Reporting | `Reporting.VAT`, `Reporting.Revenue` | `POST /run/accounting` |
| **I.23** Exports | `Exports.GenerateFEC` / `GetFECStatus` / `ExportInvoices` / `ExportRGPD` / `GetExportStatus` | `POST /run/accounting` |
| **I.24** E-reporting | `EReporting.CreateDeclaration` / `List` / `Get` / `SubmitDeclaration` | `POST /run/accounting` |
| **I.25** Archives | `Archives.List`, `Archives.Get` | `POST /run/accounting` |
| **I.26** Notifications | `Notifications.List` / `MarkRead` / `MarkAllRead` / `RetrievePreferences` / `UpdatePreferences` | `POST /run/accounting` |
| **J.27** API keys | `APIKeys.Create` / `List` / `Get` / `Roll` / `Revoke` | `POST /run/administration` |
| **J.28** Members | `Members.Invite` / `List` / `Get` / `ResendInvitation` / `UpdateRole`¹ / `Revoke`¹ | `POST /run/administration` |
| **J.29** Platform billing | `Billing.RetrieveSubscription` / `ListInvoices` / `GetInvoicePDF` / `UpdateSubscription`¹ / `Pause`¹ / `Resume`¹ / `Checkout`¹ / `Portal`¹ | `POST /run/administration` |
| **J.30** RGPD | `Account.RequestExport` / `DownloadExport` / `UpdateNotifications` (+ `ScheduleDeletion`/`CancelDeletion` documented, never auto-run)¹ | `POST /run/administration` |
| Cabinets (illustrative) | `Cabinets.List` (requires a `cabinet_*` plan) | `POST /run/administration` |
| MFA (out of band) | `client.Mfa.*` — managed in the Facturino web app, not exercised here | — |

¹ Gated behind `-allow-destructive`; otherwise the call shape is documented and
the step logs a skip.

> Notes on a few SDK names that differ from the generic surface: `Companies`
> field is `client.Companies` (PA connection lives there as `ConnectPA` /
> `TestPAConnection`); the MFA service is `client.Mfa`; reporting methods are
> `Reporting.VAT` / `Reporting.Revenue`; document XML is `Invoices.GetXML(id,
> "ubl")`.
```
