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
8. **Preflight validation** — even the dry-run is decision-first:
   `taxDecisions.create` first, then `validate.run` on the decision-backed
   payload. Validation persists nothing and does not consume the decision —
   phase D reuses it for the real create.

### D. Invoice lifecycle

9. **Decide, create from the decision, finalize** — `taxDecisions.create`
   describes the operation (no rate is stated: on the `facturino` source the
   engine concludes); `invoices.create` with `taxDecisionId` +
   `decisionLines`, buyer BG-7 and purchase-order number BT-13 — the invoice
   never restates the VAT; `invoices.finalize` for numbering; `invoices.get`;
   `invoices.getStatus`; and `invoices.list` with `convertedFrom` to find
   invoices created from the quote. Converting a quote produces a COMMERCIAL
   draft (`taxSource: null`, indicative VAT); over the API the invoice is
   created from a decision, and the draft stays a working document.
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

15b. **Deposit invoice (type 386)** — decide the deposit operation (a
     `deposit` line names the principal supply it follows through
     `relatedCategory`), create the invoice from the decision with
     `type: 'deposit'`, then finalize it. At this point the deposit has been
     *invoiced*, not paid.
15c. **Settle the deposit** — record its payment IN FULL through
     `payments.create`. This step is not optional: BT-113 is the
     `TotalPrepaidAmount`, and an amount is only prepaid once it has actually
     been collected. A deposit that is merely finalized must never be presented
     as prepaid — doing so overstates what the buyer already settled.
15d. **Balance invoice** — decide the balance operation, then create the
     invoice from the decision with
     `deposits: [{ invoiceId: '<settled deposit>' }]`. Deposits settle
     SERVER-SIDE against the DECIDED amount: the settled deposit becomes the
     BT-113 prepaid amount and reduces the amount due (BT-115, BR-CO-16); the
     decided `amountToCharge` is untouched.
15e. **Payment schedule** — pass two to twelve entries through
     `schedule: [{ amount, dueDate, label }]`. Amounts are integer cents, their
     sum equals the **remaining amount due** — the decided amount less the
     prepaid deposit, never the gross total — and the last installment is due
     on the invoice due date (BT-9). Validated server-side against the decided
     amount due.

### E. Recurring subscription

16. **Recurrence** — `recurringInvoices.create` with `taxInputs` (its
    `taxSource`, price mode and commercial lines: each occurrence is decided
    on its OWN generation date, and no decision is ever stored on the
    schedule) and a `templateInvoice` carrying presentation and terms only;
    then `list`, `get`, `update`, `pause`, and `resume`.

### F. Credit note

17. **Correction and refund** — `creditNotes.create` linked to the invoice
    with `creditedLines` (the rate, category, VATEX code and legal mention are
    inherited from the invoice's frozen snapshot, never restated),
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

### K. Decision-first billing

The order below is the point of the phase: the VAT and the exact amount to
debit come from Facturino **before** anything is collected, and the decision id
travels with the settlement so what was received can be checked against what
was decided.

Facturino imposes no payment service provider and no payment method. The flow
is provider-neutral: the decision id is carried in the payment **reference**,
which every settlement has — a transfer wording, a direct-debit mandate
reference, a cheque number, a PSP charge id. Two PSP variants are shown as
examples afterwards; both are simulated locally, and no PSP is ever contacted.

28. **Create or find the customer** — reuse the customer from phase B.
29. **Decide before any PSP call** — `taxDecisions.create` with the required
    `taxSource` (`facturino` here: the engine concludes), the customer, the
    effective civil date, the currency, the price mode and the commercial
    lines. Unit amounts are integer cents; quantities are decimal **strings**.
    The call carries a stable `Idempotency-Key`, so replaying the phase replays
    the same decision instead of taking a second one.
30. **Stop unless `status == final`** — `pending_verification` and
    `unsupported` carry `totals: null` and `amountToCharge: null`, never `0`.
    Nothing is charged and no invoice is issued; `issues` says what is missing.
31. **Collect exactly `amountToCharge` and `currency`** — never a locally
    recomputed total.
32. **Carry the decision id in the settlement reference** — whatever the means
    of payment. The demos use the decision id itself as the payment reference,
    which any settlement can hold.
    *Optional PSP variants, shown as examples only:* Stripe metadata
    `facturino_tax_decision_id`, or PayPal `custom_id` (PayPal reasons in
    decimal units, so convert from cents). Both are **simulated locally**: the
    demos never call Stripe or PayPal.
33. **Read the decision back after the simulated settlement** —
    `taxDecisions.retrieve`, from the reference carried with the payment.
34. **Verify amount, currency and buyer** against the decision. A mismatch
    means the settlement and the invoice would not describe the same operation.
35. **Create the invoice from the decision** — `invoices.create` with
    `taxDecisionId` and `decisionLines`. An invoice never states its own VAT:
    it comes from the decision, and a decision line carries presentation only
    (`taxLineRef`, `unit`, optional `product`). One final decision creates
    exactly one invoice.
36. **Finalize** — `invoices.finalize` assigns the number and fixes the content.
37. **Send to the platform only if `invoiceChannel == einvoicing`** — otherwise
    no deposit is attempted. Calling `invoices.send` outside that channel would
    be refused, and rightly so.
38. **Record the real collection** — `payments.create` on the invoice, with the
    real amount, the real date, the real method (`transfer`, `card`, `check`,
    `cash`, `direct_debit`, `sepa`, `paypal` or `other`) and the reference that
    carries the decision id. The payment axis moves; the transmission axis does
    not.
39. **Keep the e-reporting axes** — `transactionReporting` and
    `paymentReporting` are the obligations, and they hold whether or not the
    invoice travelled the network. `obligationReasons` says why each axis
    carries what it carries, and `foreignTaxReviewRequired` flags an operation
    whose foreign tax must be reviewed outside Facturino.

**Credit note on a decided invoice** — `creditNotes.create` with
`creditedLines`. The rate, the category, the VATEX code and the legal mention
are inherited from the invoice's frozen snapshot, so `items` is refused. A
credited line states EITHER `quantity` or `amountTTC`, never both; omitting
both credits the line's whole remaining balance.

**Recurrence on the decided journey** — `recurringInvoices.create` with
`taxInputs` (its `taxSource`, price mode plus commercial lines). A recurrence
stores **no** decision: each occurrence is decided on its own generation date,
so a schedule created today does not carry this quarter's rules into next
year, and no `taxDecisionId` is ever reused between occurrences.

**The other fiscal journey (`taxSource: "integration"`)** — an ERP, a
marketplace engine or an in-house rules service that already determines the
VAT declares it on the decision: each line carries the supplied `vatRate`,
`vatCode`, and where the rate is zero the `vatexCode` and `placeOfSupply`
justifying it. Facturino validates the coherence of the whole and refuses
contradictions (`integration_vat_incoherent`) — it never silently corrects a
rate. The decision, the invoice and the reporting obligations then work
exactly as on the `facturino` source: the two journeys are equals. Every
runner demonstrates a coherent integration decision, the invoice created from
it, and one refused contradiction.

### Three status axes

A document has three states that do not follow from one another:
`documentStatus` (draft / finalized / cancelled), `transmissionStatus` with its
`transmissionDetail`, and `paymentStatus`. Recording a payment never moves the
transmission axis, and a refund does not erase the collection that happened.
The `status` field stays populated as their summary projection.

### Scope

Facturino decides **French VAT and the matching French obligations**. It does
not provide worldwide tax compliance: when a foreign tax may apply, the
decision says so through `foreignTaxReviewRequired`. An operation whose
`invoiceChannel` is `none` is not deposited on a certified platform — its
obligation, if any, goes through e-reporting.

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
sandbox · taxDecisions · usage · validate · webhookEndpoints · webhook delivery

Each stack README ends with a phase-to-method table (or phase-to-request table
for the no-SDK implementation).
