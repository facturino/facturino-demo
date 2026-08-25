# Shared scenario — "Atelier Dupont" (B2B mini-SaaS)

All five demos implement the **same journey** in five different stacks. The
goal is to show how a French B2B SaaS manages **all of its billing through
Facturino**, from its first customer to accounting exports.

The fictional company, *Atelier Dupont SAS*, sells one-off services and a
monthly subscription to business customers. It collects payments through
Facturino, submits invoices to its Plateforme Agréée (PA), and exports its
accounts.

Each demo is a small executable backend. Its HTTP server exposes routes that
run scenario phases and a public endpoint that receives Facturino webhooks.
There is no full UI: the examples focus on API usage.

---

## Journey and execution order

> Every step names the Facturino operations it uses. The numbered API families
> make it possible to verify that the union of all phases covers the public API
> surface listed at the end.

### A. Bootstrap the SaaS account

1. **Current account** — `account.retrieve`: verify the key, plan, and
   `livemode`.
2. **Issuing company** — `companies.list` / `companies.get`.
2b. **Terms and onboarding** — `companies.uploadCgv` / `getCgv` / `deleteCgv`
   for the base64-encoded terms PDF, then `companies.addMilestone` for an
   onboarding milestone such as `firstInvoice`.
3. **Reference data** — `reference.listLegalForms`,
   `reference.listNafCodes`. PA connection (BYOPA) is configured in the
   Facturino web app, not through the public API. The demo therefore assumes a
   PA is connected or simulates PA status transitions in test mode with
   `sandbox.simulateStatus`.
4. **Quota usage** — `usage.retrieve`: display consumption and plan limits.

### B. Product catalogue and customer

5. **Products** — `products.create` for a monthly subscription and a one-off
   service; `products.list` with the `q`, `category`, and `active` filters;
   `products.get`; `products.update`; and `products.importCsv` /
   `products.exportCsv`.
6. **Customer** — `customers.lookup` (SIRENE/VIES), then
   `customers.create` with a `billing` contact that receives invoices by
   default; `customers.get`; `customers.update`; `customers.list`; and
   `customers.importCsv` / `customers.exportCsv`.

### C. Quote to invoice

7. **Quote** — `quotes.create`, `quotes.send`, `quotes.get`, `quotes.accept`,
   `quotes.getPdf`, `quotes.getSignatureProof`, `quotes.clone`, then
   `quotes.convert` to produce a draft invoice.
8. **Preflight validation** — `validate.run` on the invoice payload before
   creation, demonstrating EN16931 validation without issuing a document.

### D. Invoice lifecycle

9. **Create and finalize** — `invoices.create` with buyer BG-7, lines, payment
   terms, and purchase-order number BT-13; `invoices.finalize` for numbering;
   `invoices.get`; `invoices.getStatus`; and `invoices.list` with
   `convertedFrom` to find invoices created from the quote.
10. **Documents** — `invoices.getPdf`, `invoices.getFacturx`, and
    `invoices.getXml` (CII and UBL), polling asynchronous generation with
    `jobs.poll` when required.
11. **PA submission** — `invoices.send`.
12. **Payment** — `invoices.createPaymentLink`,
    `invoices.createPortalLink`, `invoices.createPaymentToken`, then
    `payments.create` and `payments.list`.
13. **Reminder and overdue state** — `invoices.remind` and
    `invoices.listEvents`.
14. **Audit trail** — `invoices.verify`, `invoices.getAuditTrail`, and
    `invoices.generateAuditTrailPdf`.
15. **Clone** — `invoices.clone` for an occasional manual recurrence.

### D2. Deposits and payment schedules

15b. **Deposit invoice (type 386)** — create an invoice with
     `type: 'deposit'`, then finalize it.
15c. **Balance invoice** — create the final invoice with
     `deposits: [{ invoiceId: '<deposit>' }]`; the paid deposit becomes BT-113
     prepaid amount and reduces the amount due.
15d. **Payment schedule** — pass two to twelve entries through
     `schedule: [{ amount, dueDate, label }]`. Amounts are integer cents, their
     sum equals the remaining amount due, and the last installment is due on
     the invoice due date (BT-9).

> The reference runners execute the standard path. Deposit and schedule
> parameters are additive examples documented here for discoverability.

### E. Recurring subscription

16. **Recurrence** — `recurringInvoices.create`, `list`, `get`, `update`,
    `pause`, and `resume`.

### F. Credit note

17. **Correction and refund** — `creditNotes.create` linked to the invoice,
    `creditNotes.finalize`, `creditNotes.send`, `creditNotes.getPdf`, and
    `creditNotes.getFacturx`; then retrieve the invoice with
    `expand=credit_notes` to obtain linked credit notes and the net balance.

### G. Purchases and received invoices

18. **Incoming invoice** — `invoices.createIncoming` /
    `invoices.listIncoming`; `receivedInvoices.list`, `get`, `approve`,
    `refuse`, `suspend`, and `recordPayment`.

### H. Webhooks

19. **Endpoint** — `webhookEndpoints.create` with the public demo URL and
    selected events; `webhookEndpoints.list`; `webhookEndpoints.test`.
20. **Delivery** — `/webhooks` verifies the signature and handles events such
    as `invoice.finalized`, `invoice.transmitted`, `invoice.paid`, and
    `quote.accepted`. The no-SDK demo verifies signatures manually; SDK demos
    use their `webhooks.*` helper.
21. **Replay** — `events.list`, `events.get`, and `events.retry`.

### I. Accounting and reporting

22. **Reports** — `reporting.vatReport` and `reporting.revenueReport`.
23. **Exports** — `exports.generateFec` + `exports.getFecStatus`, and
    `exports.exportInvoices` + `exports.getExportStatus`. Account portability
    is covered in phase J through `account.requestExport` and job polling.
24. **E-reporting** — `ereporting.createDeclaration`, `list`, `get`, and
    `submitDeclaration`.
25. **Archives** — `archives.list` and `archives.get`.

### J. Account and Facturino billing

26. **Facturino subscription** — `billing.retrieveSubscription`,
    `billing.listInvoices`, and `billing.getInvoicePdf`. Billing is read-only
    in the public API; plan changes, cancellation, and the billing portal are
    handled by the Facturino web app.
27. **Data portability** — `account.requestExport` returns a job; poll it with
    `exports.getExportStatus` until `download_url` is available.
    `account.downloadExport` serves the signed link from an `export_ready`
    notification and uses a different `rgpdexp_…` identifier.

### Outside the public developer API

- PA connection (BYOPA), subscription changes, API keys, team membership,
  product notifications, MFA, and cabinet management belong to authenticated
  web-app surfaces and are intentionally not exercised by these demos.
- In `fac_test_` mode, `sandbox.simulateStatus` advances PA states without a
  real submission and keeps the scenario deterministic.

---

## Shared conventions

- **Amounts** are integer cents (`10000` = EUR 100.00). **VAT rates** are
  hundredths of a percent (`2000` = 20.00%). Never use floating point.
- **Idempotency** — every creation POST uses an `Idempotency-Key` that remains
  stable for retries of the same logical operation.
- **Pagination** — follow forward cursors through `starting_after` and
  `has_more`.
- **Errors** — decode `{ error: { type, code, message, param, doc_url,
  request_id, hint } }` and surface `request_id` for support.
- **Business replayability** — lookup-or-create resources and reuse an existing
  draft so that the scenario can be run repeatedly.
- **Configuration** — use `FACTURINO_API_KEY`, `FACTURINO_BASE_URL`,
  `FACTURINO_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, and `PORT` from the process
  environment. See the repository `.env.example`; never commit credentials.
- **Safety** — use only `fac_test_` keys. Potentially real-world operations are
  guarded explicitly by the runners.

## Covered API families

The combined journey touches every public family at least once:

account · archives · billing · companies · creditNotes · customers ·
ereporting · events · exports · invoices · jobs · payments · products ·
quotes · receivedInvoices · recurringInvoices · reference · reporting ·
sandbox · usage · validate · webhookEndpoints · webhook delivery

Each stack README ends with a phase-to-method table (or phase-to-request table
for the no-SDK implementation).
