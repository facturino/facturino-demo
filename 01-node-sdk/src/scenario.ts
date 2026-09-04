import type Facturino from '@facturino/node'
import { ConflictError, NotFoundError } from '@facturino/node'
import type {
  Account,
  Company,
  Customer,
  Product,
  Invoice,
  Quote,
  CreditNote,
  InvoiceLineItemParam,
  TaxDecision,
  TaxDecisionLineParam,
  DecisionBackedLineParam,
  DocumentUrlResponse,
  JobResponse,
} from '@facturino/node'

import type { Config } from './config.js'
import { describeError, eur, idempotencyKey, isJobResponse, isoDate, isoDateTime, currentPeriod, log } from './lib.js'

/**
 * The shared "Atelier Dupont" scenario, end to end (steps A→K of
 * docs/SCENARIO.md), driven through the official `@facturino/node` SDK.
 *
 * Design choices:
 *  - Idempotent: lookup-or-create on the customer, reuse of an existing draft
 *    via stable `Idempotency-Key`s, so the whole run is replayable.
 *  - Deterministic in test mode: PA status transitions are forced with
 *    `sandbox.simulateStatus` instead of waiting for a real platform.
 */

const SANDBOX = (key: string): boolean => key.startsWith('fac_test_')

export class Scenario {
  constructor(
    private readonly f: Facturino,
    private readonly config: Config,
  ) {}

  /**
   * A decided line reference of the invoice phase D issued. A credit note
   * references the lines of the invoice it credits, and those references are
   * assigned server-side when the invoice comes from a converted quote — so
   * the one phase F credits is read from the document, never spelled out.
   */
  private mainLineRef = ''

  // ---------------------------------------------------------------------------
  // A. Bootstrap the SaaS account
  // ---------------------------------------------------------------------------

  /** A.1 + A.2 + A.3 + A.4 — account context, company, PA connection, quotas. */
  async bootstrap(): Promise<{ account: Account; company: Company }> {
    log.step('A', 'Bootstrap')

    // A.1 — Who am I: verify the key, plan and environment.
    const account = await this.f.account.retrieve()
    log.ok(
      `Connected as ${account.apiKeyPrefix} | plan=${account.plan} | livemode=${account.livemode}`,
    )

    // A.2 — Issuing company. Pick the first company the key is scoped to.
    const companies = await this.f.companies.list()
    const company = companies.data[0]
    if (!company) {
      throw new Error('No company on this account. Create one in the Facturino app first.')
    }
    log.ok(`Company ${company.name} (SIRET ${company.siret})`)

    // Company settings (numbering, payment terms, VAT regime, accounting,
    // reminders) are configured once in the Facturino app console — the API
    // consumes them but does not manage them. We read them off `company` here.
    log.info(`Company default payment terms: ${company.defaultPaymentTerms} days`)

    // Reference data an integration uses to power its own company/customer forms.
    const legalForms = await this.f.reference.listLegalForms({ search: 'SAS', limit: 3 })
    const nafCodes = await this.f.reference.listNafCodes({ search: 'conseil', limit: 3 })
    log.info(
      `Reference data: ${legalForms.data.length} legal forms, ${nafCodes.data.length} NAF codes`,
    )

    // A.4 — Quotas: track consumption against the plan limits so the app can
    // surface an upgrade prompt before a metered dimension returns 402.
    const usage = await this.f.usage.retrieve()
    const invoicesThisMonth = usage.counters.invoicesMonth
    const cap = invoicesThisMonth.limit != null ? `/${invoicesThisMonth.limit}` : ' (unlimited)'
    log.info(
      `Usage since ${usage.periodStart} (plan ${usage.plan}) — ` +
        `${invoicesThisMonth.used}${cap} invoices this period`,
    )

    return { account, company }
  }

  // ---------------------------------------------------------------------------
  // B. Catalogue & customer
  // ---------------------------------------------------------------------------

  /** B.5 — Products: a monthly subscription + a one-off service. */
  async catalogue(): Promise<{ subscription: Product; service: Product }> {
    log.step('B', 'Catalogue & customer (products)')

    // Idempotent create: a stable key means a re-run returns the same product.
    const subscription = await this.f.products.create(
      {
        name: 'Abonnement mensuel — Atelier Dupont',
        unitPrice: 9900, // 99,00 € in integer cents
        vatRate: 2000, // 20,00 % in centipercent
        vatCode: 'S',
        unit: 'month',
        reference: 'SUB-MONTHLY',
        category: 'subscription',
      },
      { idempotencyKey: idempotencyKey('product', 'SUB-MONTHLY') },
    )
    log.ok(`Product (subscription) ${subscription.id} — ${eur(subscription.unitPrice)}/mo`)

    const service = await this.f.products.create(
      {
        name: 'Prestation atelier (à l’heure)',
        unitPrice: 8000, // 80,00 €
        vatRate: 2000,
        vatCode: 'S',
        unit: 'hour',
        reference: 'SVC-HOUR',
        category: 'service',
      },
      { idempotencyKey: idempotencyKey('product', 'SVC-HOUR') },
    )
    log.ok(`Product (service) ${service.id} — ${eur(service.unitPrice)}/h`)

    // Read-back + update + list to exercise the rest of the resource.
    await this.f.products.get(subscription.id)
    await this.f.products.update(service.id, { category: 'prestation' })
    const list = await this.f.products.list({ limit: 5 })
    log.info(`products.list first page: ${list.data.length} item(s), has_more=${list.has_more}`)

    // Catalogue search with filters: a SaaS typically looks a product up by a
    // prefix of its name (q), scoped to a category and to active items only.
    // Here we resolve the subscription back from its name prefix.
    const byName = await this.f.products.list({ q: 'abonnement', active: true, limit: 5 })
    log.info(`products.list q="abonnement" active=true: ${byName.data.length} match(es)`)
    const subscriptions = await this.f.products.list({ category: 'subscription', active: true, limit: 5 })
    log.info(`products.list category=subscription active=true: ${subscriptions.data.length} item(s)`)

    // CSV import/export round-trip (async jobs).
    const exportJob = await this.f.products.exportCsv()
    log.info(`products.exportCsv → job ${exportJob.id} (${exportJob.status})`)

    return { subscription, service }
  }

  /** B.6 — Customer: SIRENE/VIES lookup, then lookup-or-create (idempotent). */
  async customer(): Promise<Customer> {
    log.step('B', 'Catalogue & customer (customer)')

    const siret = '55204944776279' // demo SIRET (Société Générale establishment)

    // Lookup the public registry first (no resource mutated).
    const lookup = await this.f.customers.lookup({ siret })
    if (lookup.found && lookup.data) {
      log.info(`SIRENE lookup: ${lookup.data.name} (${lookup.data.siret})`)
    } else {
      log.info(`SIRENE lookup: not found (${lookup.warning ?? 'n/a'})`)
    }

    // Lookup-or-create: if a customer with this SIRET already exists, reuse it.
    const existing = await this.f.customers.list({ limit: 100 })
    const found = existing.data.find((c) => c.siret === siret)
    if (found) {
      log.ok(`Reusing existing customer ${found.id} (${found.name})`)
      return found
    }

    const customer = await this.f.customers.create(
      {
        name: 'Beta Industries SAS',
        type: 'company',
        siret,
        vatNumber: 'FR40552049447',
        address: {
          line1: '29 boulevard Haussmann',
          postalCode: '75009',
          city: 'Paris',
          country: 'FR',
        },
        email: 'compta@beta-industries.example',
        // A `billing` contact receives the invoices by email by default.
        contacts: [{ email: 'factures@beta-industries.example', role: 'billing' }],
        paymentTerms: 30,
        preferredFormat: 'facturx',
      },
      { idempotencyKey: idempotencyKey('customer', siret) },
    )
    log.ok(`Customer ${customer.id} (${customer.name})`)
    await this.f.customers.get(customer.id)
    await this.f.customers.update(customer.id, { notes: 'Compte démo Atelier Dupont' })
    return customer
  }

  // ---------------------------------------------------------------------------
  // C. Quote → invoice
  // ---------------------------------------------------------------------------

  /** C.7 — Quote lifecycle: create, send, accept, then convert to a draft invoice. */
  async quoteToInvoice(
    customer: Customer,
    service: Product,
  ): Promise<{ draft: Invoice; quoteId: string }> {
    log.step('C', 'Quote → invoice')

    const quote: Quote = await this.f.quotes.create(
      {
        customerId: customer.id,
        // Issue date plus a 30-day validity window.
        dates: { issued: isoDate(), validUntil: isoDate(30) },
        notes: 'Devis prestation atelier',
        lines: [this.serviceLine(service, '10')],
      },
      { idempotencyKey: idempotencyKey('quote', customer.id, service.id) },
    )
    log.ok(`Quote ${quote.id} (${quote.status})`)

    await this.f.quotes.send(quote.id, { idempotencyKey: idempotencyKey('quote-send', quote.id) })
    await this.f.quotes.get(quote.id)
    const accepted = await this.f.quotes.accept(quote.id, {
      idempotencyKey: idempotencyKey('quote-accept', quote.id),
    })
    log.ok(`Quote accepted (${accepted.status})`)

    // Documents + signature proof.
    await this.documentUrlOrJob('quote PDF', () => this.f.quotes.getPdf(quote.id))
    try {
      const proof = await this.f.quotes.getSignatureProof(quote.id)
      log.info(`Signature proof URL ready (expires in ${proof.expires_in}s)`)
    } catch (err) {
      log.warn(`getSignatureProof: ${describeError(err)}`)
    }

    // C.7 — Clone the accepted quote as a fresh draft to re-propose a similar
    // deal (idempotent: a re-run returns the same clone for this quote).
    try {
      const cloned = await this.f.quotes.clone(quote.id, {
        idempotencyKey: idempotencyKey('quote-clone', quote.id),
      })
      log.ok(`Cloned to new draft quote ${cloned.id} (${cloned.status})`)
    } catch (err) {
      log.warn(`quotes.clone: ${describeError(err)}`)
    }

    // C.7 — Convert the accepted quote to a draft invoice.
    const draft = await this.f.quotes.convert(quote.id, {
      idempotencyKey: idempotencyKey('quote-convert', quote.id),
    })
    log.ok(`Converted to draft invoice ${draft.id} (${draft.status})`)
    return { draft, quoteId: quote.id }
  }

  /** C.8 — Upstream validation: decide, then dry-run the payload without emitting. */
  async validateUpstream(customer: Customer, service: Product): Promise<void> {
    log.step('C', 'Upstream validation (validate.run)')

    // Even a dry-run is decision-first: the payload references a decision, so
    // the decision is taken before anything is validated — and the validation
    // persists nothing. The decision is idempotent, so the invoice phase can
    // reuse it if the same operation is created for real later.
    const decision = await this.decide(customer, [this.serviceDecisionLine('2')], 'validate', service.id)
    if (!decision) return
    const invoicePayload = this.invoiceBodyFromDecision(customer, decision.id, [
      { taxLineRef: 'svc-heure', unit: 'hour', product: service.id },
    ])
    const result = await this.f.validate.run(invoicePayload)
    log.ok(`Invoice payload valid=${result.valid}, ${result.warnings.length} warning(s)`)
  }

  // ---------------------------------------------------------------------------
  // D. Invoice lifecycle
  // ---------------------------------------------------------------------------

  /**
   * D.9 → D.15 — decide, bind, finalize, fetch documents, deposit to PA, take
   * payment, remind, audit, clone.
   *
   * The invoice is the one the QUOTE produced: the decision is bound to that
   * same commercial draft. The cycle is convert → decide → bind → finalize on
   * ONE document — a second invoice would leave the converted draft orphaned
   * and break the quote lineage.
   */
  async invoiceLifecycle(
    company: Company,
    customer: Customer,
    draftFromQuote: Invoice,
    sourceQuoteId: string,
  ): Promise<Invoice> {
    log.step('D', 'Invoice lifecycle')

    // D.9 — Trace invoices issued from the converted quote (filter convertedFrom).
    const fromQuote = await this.f.invoices.list({ convertedFrom: sourceQuoteId, limit: 5 })
    log.info(`invoices.list convertedFrom=${sourceQuoteId}: ${fromQuote.data.length} invoice(s)`)

    // D.9 — Decide the operation the CONVERTED DRAFT states, then bind the
    // decision to that same invoice. The commercial block is read back from the
    // draft: its line references are server-assigned at conversion, and the
    // decision must state exactly the operation the draft carries.
    const commercial = draftFromQuote.commercialDraft
    if (!commercial || commercial.lines.length === 0) {
      throw new Error(
        `converted draft ${draftFromQuote.id} carries no commercial operation — the quote cycle cannot continue`,
      )
    }
    const decision = await this.decide(
      customer,
      commercial.lines.map((line) => ({
        reference: line.reference,
        description: line.description,
        category: line.supplyCategory,
        rateCategory: line.rateCategory,
        unitAmount: line.unitPrice,
        quantity: line.quantity,
        ...(line.discount ? { discount: line.discount } : {}),
      })),
      'quote-invoice', draftFromQuote.id,
    )
    if (!decision) {
      throw new Error(`the operation of draft ${draftFromQuote.id} is not decidable — no invoice is issued`)
    }
    let invoice = await this.f.invoices.bindTaxDecision(
      draftFromQuote.id,
      {
        taxDecisionId: decision.id,
        decisionLines: commercial.lines.map((line) => ({
          taxLineRef: line.reference,
          unit: line.unit,
          ...(line.product ? { product: line.product } : {}),
        })),
      },
      { idempotencyKey: idempotencyKey('bind-decision', draftFromQuote.id) },
    )
    log.ok(`Decision ${decision.id} bound to the converted draft ${invoice.id} (${invoice.status})`)
    const mainLine = commercial.lines[0]
    if (!mainLine) {
      throw new Error(`converted draft ${draftFromQuote.id} carries no line to credit later`)
    }
    this.mainLineRef = mainLine.reference

    invoice = await this.f.invoices.finalize(invoice.id, {
      idempotencyKey: idempotencyKey('invoice-finalize', invoice.id),
    })
    log.ok(`Finalized invoice ${invoice.number} (${invoice.status})`)

    await this.f.invoices.get(invoice.id)
    const status = await this.f.invoices.getStatus(invoice.id)
    log.info(`Status: ${status.status}, paStatus=${status.einvoicing.paStatus ?? 'n/a'}`)

    // D.10 — Documents (PDF, Factur-X PDF/A-3, CII + UBL XML), polling jobs.
    await this.documentUrlOrJob('invoice PDF', () => this.f.invoices.getPdf(invoice.id))
    await this.documentUrlOrJob('Factur-X', () => this.f.invoices.getFacturx(invoice.id))
    try {
      const cii = await this.f.invoices.getXml(invoice.id, 'cii')
      const ubl = await this.f.invoices.getXml(invoice.id, 'ubl')
      log.info(`XML retrieved: CII ${cii.length} bytes, UBL ${ubl.length} bytes`)
    } catch (err) {
      log.warn(`getXml: ${describeError(err)}`)
    }

    // D.11 — Deposit to the PA (async, 202). In test mode we then force the PA
    // status transitions deterministically so webhooks fire without a real PA.
    try {
      const sent = await this.f.invoices.send(invoice.id, {
        idempotencyKey: idempotencyKey('invoice-send', invoice.id),
      })
      log.ok(`Submitted to PA (status ${sent.status})`)
      await this.driveePaStatuses(invoice.id)
    } catch (err) {
      log.warn(`invoices.send: ${describeError(err)}`)
    }

    // D.12 — Collection: payment link + portal link (Stripe), then record a payment.
    try {
      // Stripe requires absolute return URLs; fall back to a placeholder host
      // when this demo isn't deployed behind a public domain.
      const returnBase = this.config.publicBaseUrl || 'https://atelier-dupont.example.com'
      const link = await this.f.invoices.createPaymentLink(
        invoice.id,
        { success_url: `${returnBase}/paid`, cancel_url: `${returnBase}/cancel` },
        { idempotencyKey: idempotencyKey('payment-link', invoice.id) },
      )
      log.info(`Payment link: ${link.url}`)
    } catch (err) {
      log.warn(`createPaymentLink: ${describeError(err)}`)
    }
    try {
      const portal = await this.f.invoices.createPortalLink(invoice.id, {
        idempotencyKey: idempotencyKey('portal-link', invoice.id),
      })
      log.info(`Client portal link expires at ${portal.expires_at}`)
    } catch (err) {
      log.warn(`createPortalLink: ${describeError(err)}`)
    }

    // D.12 — Dunning: send a payment reminder while the invoice is still unpaid.
    try {
      await this.f.invoices.remind(invoice.id, { idempotencyKey: idempotencyKey('remind', invoice.id) })
      log.ok('Reminder requested')
    } catch (err) {
      log.warn(`remind: ${describeError(err)}`)
    }

    // D.13 — Record a manual payment of the full amount, then list payments.
    try {
      // All amounts are integer cents; `amountDue` is what remains to be paid.
      const amountDue = invoice.totals.amountDue
      const payment = await this.f.invoices.payments.create(
        invoice.id,
        { amount: amountDue || 11880, method: 'transfer', reference: 'VIR-2026-0042', paidAt: isoDate() },
        { idempotencyKey: idempotencyKey('payment', invoice.id) },
      )
      log.ok(`Payment ${payment.id} recorded (${eur(payment.amount)})`)
      const payments = await this.f.invoices.payments.list(invoice.id)
      log.info(`payments.list: ${payments.data.length} payment(s)`)
    } catch (err) {
      log.warn(`payments.create: ${describeError(err)}`)
    }
    const events = await this.f.invoices.listEvents(invoice.id)
    log.info(`Lifecycle: ${events.data.length} entries`)

    // D.14 — Audit trail: hash-chain verification + audit log + audit PDF (Pro).
    try {
      const verify = await this.f.invoices.verify(invoice.id)
      log.ok(`Hash chain verified=${verify.verified} (length ${verify.chain_length})`)
      const trail = await this.f.invoices.getAuditTrail(invoice.id, { limit: 10 })
      log.info(`Audit trail: ${trail.data.length} entr(y/ies)`)
      const pdfJob = await this.f.invoices.generateAuditTrailPdf(invoice.id, {
        idempotencyKey: idempotencyKey('audit-pdf', invoice.id),
      })
      log.info(`Audit-trail PDF job ${pdfJob.id} (${pdfJob.status})`)
    } catch (err) {
      log.warn(`audit trail (Pro plan): ${describeError(err)}`)
    }

    // D.15 — Clone as a new draft (manual one-off recurrence).
    try {
      const clone = await this.f.invoices.clone(invoice.id, {
        idempotencyKey: idempotencyKey('clone', invoice.id),
      })
      log.ok(`Cloned to new draft ${clone.id}`)
      // Keep the account tidy: the clone is a disposable draft.
      await this.f.invoices.del(clone.id).catch(() => undefined)
    } catch (err) {
      log.warn(`clone: ${describeError(err)}`)
    }

    void company
    return invoice
  }

  // ---------------------------------------------------------------------------
  // E. Recurring subscription (SaaS core)
  // ---------------------------------------------------------------------------

  /** E.16 — A monthly recurring invoice template, paused and resumed. */
  async recurring(customer: Customer, subscription: Product): Promise<void> {
    log.step('E', 'Recurring subscription')

    // `taxInputs` carries the OPERATION and its fiscal source; each occurrence
    // is decided on its own generation date. `templateInvoice` carries
    // presentation and terms only — never a line, never a rate.
    const recurring = await this.f.recurringInvoices.create(
      {
        customerId: customer.id,
        frequency: 'monthly',
        startDate: isoDate(),
        nextGenerationDate: isoDate(30),
        autoFinalize: true,
        autoSend: false,
        taxInputs: {
          taxSource: 'facturino',
          priceMode: 'tax_exclusive',
          lines: [{
            ...this.subscriptionDecisionLine(subscription),
            unit: 'month',
            product: subscription.id,
          }],
        },
        templateInvoice: {
          paymentMethod: 'transfer',
          paymentTermsDays: 30,
          notes: 'Abonnement mensuel Atelier Dupont',
        },
      },
      { idempotencyKey: idempotencyKey('recurring', customer.id, subscription.id) },
    )
    log.ok(`Recurring invoice ${recurring.id} (${recurring.frequency}, next ${recurring.nextGenerationDate})`)

    await this.f.recurringInvoices.get(recurring.id)
    await this.f.recurringInvoices.update(recurring.id, { autoSend: true })
    await this.f.recurringInvoices.pause(recurring.id)
    await this.f.recurringInvoices.resume(recurring.id)
    const list = await this.f.recurringInvoices.list({ status: 'active', limit: 5 })
    log.info(`recurringInvoices.list: ${list.data.length} active`)
  }

  // ---------------------------------------------------------------------------
  // F. Credit note
  // ---------------------------------------------------------------------------

  /** F.17 — A partial credit note linked to a finalized invoice, then finalize + send. */
  async creditNote(customer: Customer, invoice: Invoice, service: Product): Promise<void> {
    log.step('F', 'Credit note')

    let creditNote: CreditNote
    try {
      // `creditedLines` references the invoice's DECIDED lines: the rate, the
      // category, the VATEX code and the legal mention are inherited from the
      // frozen snapshot, never restated. `amountTTC` credits a fraction.
      creditNote = await this.f.creditNotes.create(
        {
          relatedInvoiceId: invoice.id,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Geste commercial — remise sur l’abonnement',
          // The reference of a line ON THE CREDITED INVOICE: it is assigned
          // server-side when the invoice comes from a converted quote.
          creditedLines: [{ taxLineRef: this.mainLineRef, amountTTC: 1188 }],
          dates: { issued: isoDate() },
        },
        { idempotencyKey: idempotencyKey('credit-note', invoice.id) },
      )
      log.ok(`Credit note ${creditNote.id} (${creditNote.status})`)
    } catch (err) {
      // Credit notes require the related invoice to be finalized + e-invoicing plan.
      log.warn(`creditNotes.create: ${describeError(err)}`)
      return
    }
    void customer
    void service

    try {
      const finalized = await this.f.creditNotes.finalize(creditNote.id, {
        idempotencyKey: idempotencyKey('credit-note-finalize', creditNote.id),
      })
      log.ok(`Credit note finalized ${finalized.number}`)
      await this.f.creditNotes.send(creditNote.id, {
        idempotencyKey: idempotencyKey('credit-note-send', creditNote.id),
      })
      await this.documentUrlOrJob('credit-note PDF', () => this.f.creditNotes.getPdf(creditNote.id))
      await this.documentUrlOrJob('credit-note Factur-X', () => this.f.creditNotes.getFacturx(creditNote.id))

      // F.17 — Re-read the source invoice with its linked credit notes inlined.
      // `expanded.net_balance` is the TTC total minus the credited amounts.
      const expanded = await this.f.invoices.get(invoice.id, { expand: ['credit_notes'] })
      const linked = expanded.expanded?.credit_notes ?? []
      log.info(
        `Invoice ${invoice.id}: ${linked.length} linked credit note(s), net_balance=${
          expanded.expanded?.net_balance ?? 'n/a'
        }`,
      )
    } catch (err) {
      log.warn(`credit note finalize/send: ${describeError(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // G. Purchases (received invoices)
  // ---------------------------------------------------------------------------

  /** G.18 — Incoming supplier invoices + the received-invoice approval workflow. */
  async purchases(): Promise<void> {
    log.step('G', 'Purchases (received invoices)')

    // Register an incoming invoice received from a supplier.
    try {
      const incoming = await this.f.invoices.createIncoming(
        {
          senderName: 'Fournisseur Démo SARL',
          senderSiret: '40483304800022',
          amount: 60000, // total incl. VAT, in integer cents
          reference: 'F-SUP-2026-118',
        },
        { idempotencyKey: idempotencyKey('incoming', 'F-SUP-2026-118') },
      )
      log.ok(`Incoming invoice ${incoming.id}`)
    } catch (err) {
      log.warn(`createIncoming: ${describeError(err)}`)
    }
    const incomingList = await this.f.invoices.listIncoming({ limit: 5 })
    log.info(`listIncoming: ${incomingList.data.length} item(s)`)

    // Received-invoices: the e-invoicing inbox fed by the PA.
    const received = await this.f.receivedInvoices.list({ limit: 5 })
    log.info(`receivedInvoices.list: ${received.data.length} item(s)`)
    const first = received.data[0]
    if (!first) {
      log.skip('no received invoice to approve/refuse/suspend (empty inbox)')
      return
    }
    await this.f.receivedInvoices.get(first.id)
    try {
      await this.f.receivedInvoices.approve(first.id)
      await this.f.receivedInvoices.recordPayment(first.id, {
        amount: 60000,
        method: 'transfer',
        reference: 'VIR-SUP-118',
        paidAt: isoDateTime(),
      })
      log.ok(`Received invoice ${first.id} approved + payment recorded`)
    } catch (err) {
      log.warn(`received invoice workflow: ${describeError(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // H. Webhooks
  // ---------------------------------------------------------------------------

  /**
   * H.19 + H.21 — register a webhook endpoint (server's public /webhooks URL),
   * test it, then exercise the event log (list / get / retry). The inbound
   * reception + signature verification lives in `webhook.ts`.
   *
   * Returns the created endpoint's signing secret so the operator can wire it
   * into FACTURINO_WEBHOOK_SECRET for the receiver.
   */
  async webhooks(): Promise<{ secret?: string }> {
    log.step('H', 'Webhooks')

    if (!this.config.publicBaseUrl) {
      log.skip('PUBLIC_BASE_URL not set — cannot register a reachable endpoint')
    } else {
      const url = `${this.config.publicBaseUrl.replace(/\/+$/, '')}/webhooks`
      // Reuse an existing endpoint with the same URL if present (idempotent).
      const existing = await this.f.webhookEndpoints.list({ limit: 100 })
      const match = existing.data.find((e) => e.url === url)
      let secret: string | undefined
      if (match) {
        log.ok(`Reusing webhook endpoint ${match.id} (secret not re-shown)`)
        await this.f.webhookEndpoints.test(match.id)
      } else {
        const endpoint = await this.f.webhookEndpoints.create(
          {
            url,
            description: 'Atelier Dupont demo receiver',
            events: [
              'invoice.finalized',
              'invoice.transmitted',
              'invoice.paid',
              'quote.accepted',
              'credit_note.finalized',
            ],
          },
          { idempotencyKey: idempotencyKey('webhook-endpoint', url) },
        )
        secret = endpoint.secret
        log.ok(`Webhook endpoint ${endpoint.id} created`)
        log.info('Set this as FACTURINO_WEBHOOK_SECRET for the /webhooks receiver:', endpoint.secret)
        await this.f.webhookEndpoints.test(endpoint.id)
      }
      // Continue to the event log below, returning the secret at the end.
      await this.replayEvents()
      return secret !== undefined ? { secret } : {}
    }

    await this.replayEvents()
    return {}
  }

  private async replayEvents(): Promise<void> {
    // H.21 — Inspect and replay past events.
    const events = await this.f.events.list({ limit: 5 })
    log.info(`events.list: ${events.data.length} recent event(s)`)
    const first = events.data[0]
    if (first) {
      await this.f.events.get(first.id)
      try {
        await this.f.events.retry(first.id)
        log.ok(`Replayed event ${first.id} (${first.type})`)
      } catch (err) {
        log.warn(`events.retry: ${describeError(err)}`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // I. Accounting & steering
  // ---------------------------------------------------------------------------

  /** I.22 → I.25 — reporting, exports, e-reporting, archives. */
  async accounting(): Promise<void> {
    log.step('I', 'Accounting & steering')

    const periodStart = `${currentPeriod()}-01`
    const periodEnd = isoDate()

    // I.22 — VAT + revenue reports (Essential+).
    try {
      const vat = await this.f.reporting.vatReport({ period_start: periodStart, period_end: periodEnd })
      log.info(`VAT report: totalHT=${eur(vat.totalHT)}, totalVAT=${eur(vat.totalVAT)}, invoices=${vat.invoiceCount}`)
      const revenue = await this.f.reporting.revenueReport({
        period_start: periodStart,
        period_end: periodEnd,
        group_by: 'month',
      })
      log.info(`Revenue report: net=${revenue.revenue.net}, outstanding=${revenue.payments.outstanding}`)
    } catch (err) {
      log.warn(`reporting (Essential+): ${describeError(err)}`)
    }

    // I.23 — Exports: FEC (Pro+), invoices ZIP (all plans), RGPD.
    try {
      const fec = await this.f.exports.generateFec(
        { period_start: periodStart, period_end: periodEnd },
        { idempotencyKey: idempotencyKey('fec', periodStart, periodEnd) },
      )
      log.info(`FEC export job ${fec.id} (${fec.status})`)
      await this.f.exports.getFecStatus(fec.id).catch(() => undefined)
    } catch (err) {
      log.warn(`exports.generateFec (Pro+): ${describeError(err)}`)
    }
    try {
      const invoicesZip = await this.f.exports.exportInvoices(
        { period_start: periodStart, period_end: periodEnd },
        { idempotencyKey: idempotencyKey('export-invoices', periodEnd) },
      )
      log.info(`Invoices ZIP export job ${invoicesZip.id}`)
    } catch (err) {
      log.warn(`exports.exportInvoices: ${describeError(err)}`)
    }
    // RGPD data portability is demonstrated per-account in step J via
    // account.requestExport (article 20 RGPD).

    // I.24 — E-reporting declaration (B2C transactions), submitted.
    try {
      const declaration = await this.f.ereporting.createDeclaration(
        {
          type: 'b2c',
          period: currentPeriod(),
          lines: [{ category: 'sales_standard', amount: 120000, vatRate: 2000, vatAmount: 24000 }],
        },
        { idempotencyKey: idempotencyKey('ereporting', currentPeriod()) },
      )
      log.ok(`E-reporting declaration ${declaration.id} (${declaration.status})`)
      await this.f.ereporting.get(declaration.id)
      await this.f.ereporting.submitDeclaration(declaration.id, {
        idempotencyKey: idempotencyKey('ereporting-submit', declaration.id),
      })
      const declarations = await this.f.ereporting.list({ limit: 5 })
      log.info(`ereporting.list: ${declarations.data.length} declaration(s)`)
    } catch (err) {
      log.warn(`ereporting: ${describeError(err)}`)
    }

    // I.25 — Archives (legal storage).
    try {
      const archives = await this.f.archives.list({ limit: 5 })
      log.info(`archives.list: ${archives.data.length} archive(s)`)
      const firstArchive = archives.data[0]
      if (firstArchive) await this.f.archives.get(firstArchive.id)
    } catch (err) {
      log.warn(`archives: ${describeError(err)}`)
    }

  }

  // ---------------------------------------------------------------------------
  // J. Account administration
  // ---------------------------------------------------------------------------

  /** J.29 + J.30 — Facturino billing (read-only) and the RGPD data export. */
  async administration(account: Account, company: Company): Promise<void> {
    log.step('J', 'Account administration')

    // J.29 — Facturino's own billing (Facturino → user). Read-only surface.
    try {
      const subscription = await this.f.billing.retrieveSubscription()
      log.info(`Facturino subscription: plan=${subscription.plan} status=${subscription.status}`)
      const invoices = await this.f.billing.listInvoices({ limit: 5 })
      log.info(`billing.listInvoices: ${invoices.data.length} platform invoice(s)`)
      const firstPlatformInvoice = invoices.data[0]
      if (firstPlatformInvoice) {
        await this.f.billing.getInvoicePdf(firstPlatformInvoice.id).catch(() => undefined)
      }
    } catch (err) {
      log.warn(`billing: ${describeError(err)}`)
    }

    // J.30 — RGPD: request a data export, then poll the job — the download
    // URL surfaces on `GET /v1/exports/:jobId` (`download_url`) once the
    // worker has finished. The dedicated `/account/exports/:id/download`
    // route serves the `export_ready` notification link (`rgpdexp_…` id),
    // not the job id.
    try {
      const exportReq = await this.f.account.requestExport()
      log.ok(`RGPD export queued ${exportReq.id} (status ${exportReq.status})`)
      const status = await this.f.exports.getExportStatus(exportReq.id)
      log.info(`Export status=${status.status}${status.download_url ? ' — download URL ready' : ' (still processing)'}`)
    } catch (err) {
      log.warn(`account RGPD: ${describeError(err)}`)
    }

    void account
    void company
  }

  // ---------------------------------------------------------------------------
  // K. Complete API surface
  // ---------------------------------------------------------------------------

  /**
   * Exercises every remaining business endpoint not already shown in A→K, so the
   * demo doubles as an exhaustive, runnable reference for the SDK. Throwaway
   * resources are created then deleted; each block is independent so an
   * unsupported operation (e.g. a plan-gated feature, or an empty PA inbox)
   * never aborts the rest.
   */
  async coverage(
    company: Company,
    customer: Customer,
    subscription: Product,
    service: Product,
    invoice: Invoice,
  ): Promise<void> {
    log.step('K', 'Complete API surface')

    // Company — read, update, CGV round-trip, onboarding milestone.
    try {
      await this.f.companies.get(company.id)
      await this.f.companies.update(company.id, { website: 'https://atelier-dupont.example' })
      const cgvPdf = Buffer.from('%PDF-1.4\n% Demo terms & conditions\n').toString('base64')
      await this.f.companies.uploadCgv(company.id, cgvPdf)
      await this.f.companies.getCgv(company.id)
      await this.f.companies.deleteCgv(company.id)
      await this.f.companies.addMilestone(company.id, 'firstInvoice')
      log.ok('companies: get / update / CGV upload+get+delete / milestone')
    } catch (err) {
      log.warn(`companies admin: ${describeError(err)}`)
    }

    // Customer — CSV round-trip + soft-delete on a throwaway.
    try {
      const tmp = await this.f.customers.create(
        {
          name: 'Coverage Throwaway SAS',
          type: 'company',
          address: { line1: '1 rue de la Couverture', postalCode: '75001', city: 'Paris', country: 'FR' },
        },
        { idempotencyKey: idempotencyKey('cov-customer') },
      )
      await this.f.customers.exportCsv()
      await this.f.customers.importCsv('name,email\nCoverage Import SARL,import@example.test\n')
      await this.f.customers.del(tmp.id)
      log.ok('customers: exportCsv / importCsv / delete')
    } catch (err) {
      log.warn(`customers extras: ${describeError(err)}`)
    }

    // Product — CSV import + soft-delete on a throwaway.
    try {
      const tmp = await this.f.products.create(
        { name: 'Coverage Throwaway', unitPrice: 1000, vatRate: 2000, vatCode: 'S', unit: 'unit', reference: 'COV-PROD' },
        { idempotencyKey: idempotencyKey('cov-product') },
      )
      await this.f.products.importCsv('name,unitPrice,vatRate\nCoverage Import,1500,2000\n')
      await this.f.products.del(tmp.id)
      log.ok('products: importCsv / delete')
    } catch (err) {
      log.warn(`products extras: ${describeError(err)}`)
    }

    // Quote — list / update / email / refuse, plus delete on a fresh draft.
    try {
      const list = await this.f.quotes.list({ limit: 5 })
      log.info(`quotes.list: ${list.data.length} item(s)`)
      const q = await this.f.quotes.create(
        { customerId: customer.id, dates: { issued: isoDate(), validUntil: isoDate(30) }, lines: [this.serviceLine(service, '1')] },
        { idempotencyKey: idempotencyKey('cov-quote') },
      )
      await this.f.quotes.update(q.id, { notes: 'Coverage update' })
      await this.f.quotes.send(q.id, { idempotencyKey: idempotencyKey('cov-quote-send', q.id) })
      await this.f.quotes.email(q.id).catch((e) => log.warn(`quotes.email: ${describeError(e)}`))
      await this.f.quotes.refuse(q.id, { idempotencyKey: idempotencyKey('cov-quote-refuse', q.id) })
      const draft = await this.f.quotes.create(
        { customerId: customer.id, dates: { issued: isoDate(), validUntil: isoDate(30) }, lines: [this.serviceLine(service, '1')] },
        { idempotencyKey: idempotencyKey('cov-quote-del') },
      )
      await this.f.quotes.del(draft.id)
      log.ok('quotes: list / update / email / refuse / delete')
    } catch (err) {
      log.warn(`quotes extras: ${describeError(err)}`)
    }

    // Credit note — list / get / update / delete on a draft, plus XML + email
    // on a finalized one (XML and email require a finalized document).
    // A credit note can never exceed the total of its related invoice
    // (cumulated across the invoice's credit notes), so the block uses a
    // dedicated throwaway invoice — re-runs always start with a fresh cap.
    try {
      const list = await this.f.creditNotes.list({ limit: 5 })
      log.info(`creditNotes.list: ${list.data.length} item(s)`)

      const cnDecision = await this.decide(
        customer, [this.serviceDecisionLine('1')], 'cov-cn', `${Date.now()}`,
      )
      if (!cnDecision) throw new Error('coverage decision is not final')
      const cnInvoiceDraft = await this.f.invoices.create(
        this.invoiceBodyFromDecision(customer, cnDecision.id, [
          { taxLineRef: 'svc-heure', unit: 'hour', product: service.id },
        ]),
        { idempotencyKey: idempotencyKey('cov-cn-invoice', cnDecision.id) },
      )
      const cnInvoice = await this.f.invoices.finalize(cnInvoiceDraft.id, {
        idempotencyKey: idempotencyKey('cov-cn-invoice-fin', cnInvoiceDraft.id),
      })

      const draft = await this.f.creditNotes.create(
        {
          relatedInvoiceId: cnInvoice.id,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Coverage credit note (draft)',
          creditedLines: [{ taxLineRef: 'svc-heure', amountTTC: 960 }],
          dates: { issued: isoDate() },
        },
        { idempotencyKey: idempotencyKey('cov-credit-note-draft', cnInvoice.id) },
      )
      await this.f.creditNotes.get(draft.id)
      await this.f.creditNotes.update(draft.id, { notes: 'Coverage update' })
      await this.f.creditNotes.del(draft.id)

      const finalDraft = await this.f.creditNotes.create(
        {
          relatedInvoiceId: cnInvoice.id,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Coverage credit note (finalized)',
          creditedLines: [{ taxLineRef: 'svc-heure', amountTTC: 960 }],
          dates: { issued: isoDate() },
        },
        { idempotencyKey: idempotencyKey('cov-credit-note-final', cnInvoice.id) },
      )
      await this.f.creditNotes.finalize(finalDraft.id, { idempotencyKey: idempotencyKey('cov-cn-fin', finalDraft.id) })
      await this.f.creditNotes.getXml(finalDraft.id)
      await this.f.creditNotes.email(finalDraft.id).catch((e) => log.warn(`creditNotes.email: ${describeError(e)}`))
      log.ok('creditNotes: list / get / update / delete / xml / email')
    } catch (err) {
      log.warn(`creditNotes extras: ${describeError(err)}`)
    }

    // Invoice — update + soft-delete a draft; payment, payment-token and email
    // on a finalized throwaway; cancel a separate draft (only draft invoices can
    // be cancelled — a finalized invoice is immutable under CGI art. 289).
    try {
      // One final decision creates exactly ONE invoice: each throwaway
      // document below takes its own decision.
      const draftDecision = await this.decide(
        customer, [this.subscriptionDecisionLine(subscription)], 'cov-invoice-draft',
      )
      if (!draftDecision) throw new Error('coverage decision is not final')
      const draft = await this.f.invoices.create(
        this.invoiceBodyFromDecision(customer, draftDecision.id, [
          { taxLineRef: 'abo-mensuel', unit: 'month', product: subscription.id },
        ]),
        { idempotencyKey: idempotencyKey('cov-invoice-draft') },
      )
      // Only non-fiscal fields are patchable: the operation belongs to the
      // decision, which is immutable.
      await this.f.invoices.update(draft.id, { notes: 'Coverage update' })
      await this.f.invoices.del(draft.id)

      const paidDecision = await this.decide(
        customer, [this.subscriptionDecisionLine(subscription)], 'cov-invoice-paid',
      )
      if (!paidDecision) throw new Error('coverage decision is not final')
      const paid = await this.f.invoices.create(
        this.invoiceBodyFromDecision(customer, paidDecision.id, [
          { taxLineRef: 'abo-mensuel', unit: 'month', product: subscription.id },
        ]),
        { idempotencyKey: idempotencyKey('cov-invoice-paid') },
      )
      await this.f.invoices.finalize(paid.id, { idempotencyKey: idempotencyKey('cov-inv-paid-fin', paid.id) })
      await this.f.payments.create(
        paid.id,
        { amount: 1000, method: 'transfer', paidAt: isoDate() },
        { idempotencyKey: idempotencyKey('cov-payment', paid.id) },
      )
      await this.f.invoices.createPaymentToken(paid.id).catch((e) => log.warn(`createPaymentToken: ${describeError(e)}`))
      await this.f.invoices.email(paid.id).catch((e) => log.warn(`invoices.email: ${describeError(e)}`))

      const cancelDecision = await this.decide(
        customer, [this.subscriptionDecisionLine(subscription)], 'cov-invoice-cancel',
      )
      if (!cancelDecision) throw new Error('coverage decision is not final')
      const toCancel = await this.f.invoices.create(
        this.invoiceBodyFromDecision(customer, cancelDecision.id, [
          { taxLineRef: 'abo-mensuel', unit: 'month', product: subscription.id },
        ]),
        { idempotencyKey: idempotencyKey('cov-invoice-cancel') },
      )
      await this.f.invoices.cancel(toCancel.id, { idempotencyKey: idempotencyKey('cov-inv-cancel-do', toCancel.id) })
      log.ok('invoices: update / delete / payment / payment-token / email / cancel')
    } catch (err) {
      log.warn(`invoices extras: ${describeError(err)}`)
    }

    // Recurring — delete a throwaway plan.
    try {
      const rec = await this.f.recurringInvoices.create(
        {
          customerId: customer.id,
          frequency: 'monthly',
          startDate: isoDate(),
          nextGenerationDate: isoDate(30),
          autoFinalize: false,
          autoSend: false,
          taxInputs: {
            taxSource: 'facturino',
            priceMode: 'tax_exclusive',
            lines: [{ ...this.subscriptionDecisionLine(subscription), unit: 'month', product: subscription.id }],
          },
          templateInvoice: { paymentMethod: 'transfer', paymentTermsDays: 30 },
        },
        { idempotencyKey: idempotencyKey('cov-recurring') },
      )
      await this.f.recurringInvoices.del(rec.id)
      log.ok('recurringInvoices: delete')
    } catch (err) {
      log.warn(`recurring delete: ${describeError(err)}`)
    }

    // Received invoices — refuse / suspend operate on the PA inbox, which is fed
    // by the platform. Exercise them when the inbox has actionable items.
    try {
      const inbox = await this.f.receivedInvoices.list({ limit: 10 })
      const suspendable = inbox.data.find((r) => r.status === 'received' || r.status === 'available')
      if (suspendable) {
        await this.f.receivedInvoices.suspend(suspendable.id)
        log.ok(`receivedInvoices.suspend on ${suspendable.id}`)
      } else {
        log.skip('receivedInvoices.refuse/suspend — no actionable item in the PA inbox')
      }
    } catch (err) {
      log.warn(`receivedInvoices refuse/suspend: ${describeError(err)}`)
    }

    // Webhook endpoint — get / update / delete on a throwaway. The URL must be
    // a public, DNS-resolvable HTTPS host (validated at creation) — example.com
    // resolves, and the endpoint is deleted right after.
    try {
      const wh = await this.f.webhookEndpoints.create(
        { url: 'https://example.com/coverage-webhook', description: 'Coverage throwaway', events: ['invoice.finalized'] },
        { idempotencyKey: idempotencyKey('cov-webhook') },
      )
      await this.f.webhookEndpoints.get(wh.id)
      await this.f.webhookEndpoints.update(wh.id, { description: 'Coverage updated' })
      await this.f.webhookEndpoints.del(wh.id)
      log.ok('webhookEndpoints: get / update / delete')
    } catch (err) {
      log.warn(`webhookEndpoints extras: ${describeError(err)}`)
    }

    // Exports — generic job status (alongside the FEC-specific status shown in I).
    try {
      const periodStart = `${currentPeriod()}-01`
      const fec = await this.f.exports.generateFec(
        { period_start: periodStart, period_end: isoDate() },
        { idempotencyKey: idempotencyKey('cov-fec', periodStart) },
      )
      await this.f.exports.getExportStatus(fec.id)
      log.ok('exports: getExportStatus')
    } catch (err) {
      log.warn(`exports.getExportStatus: ${describeError(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Build an invoice line for the monthly subscription product. */
  // ---------------------------------------------------------------------------
  // K. Decision-first billing
  // ---------------------------------------------------------------------------

  /**
   * K — the decision-first journey: decide, charge the decided amount, verify
   * after capture, then invoice against the decision.
   *
   * This is the order that matters. The VAT and the exact amount to debit come
   * from Facturino BEFORE anything is collected, and the decision id travels
   * with the settlement so what was received can be checked against what was
   * decided.
   *
   * Facturino imposes no payment service provider and no payment method. The
   * flow below is provider-neutral: the decision id is carried in the payment
   * REFERENCE, which every settlement has — a transfer, a direct debit, a
   * cheque, cash, or a PSP capture. Two PSP variants are shown afterwards as
   * examples; both are simulated locally, and no PSP is ever contacted.
   */
  async taxDecision(customer: Customer, subscription: Product): Promise<Invoice | null> {
    log.step('K', 'Decision-first billing')

    // K.2 — Decide BEFORE any payment. The idempotency key is stable for this
    // order, so replaying the phase replays the same decision.
    const orderRef = `atelier-dupont-${isoDate()}`
    const decision = await this.f.taxDecisions.create(
      {
        // Facturino determines the VAT: the lines DESCRIBE the operation and
        // never state a rate. `taxSource: 'integration'` is the other journey,
        // shown in integrationDecision() below.
        taxSource: 'facturino',
        customerId: customer.id,
        // The effective date drives the applicable rules — not the wall clock.
        effectiveAt: isoDate(),
        currency: 'eur',
        priceMode: 'tax_exclusive',
        lines: [{
          reference: 'abo-pro',
          description: subscription.name,
          // A subscription delivered online is an electronically supplied
          // service: it carries its own place-of-supply rules.
          category: 'electronically_supplied_services',
          rateCategory: 'standard',
          unitAmount: 9900, // integer cents
          quantity: '1', // decimal STRING, never a float
        }],
      },
      { idempotencyKey: idempotencyKey('tax-decision', orderRef) },
    )
    log.ok(`Decision ${decision.id} — status=${decision.status}`)

    // K.3 — Stop immediately unless the decision is final. `pending_verification`
    // does not mean "nothing to charge": the amounts are null, not zero.
    if (decision.status !== 'final' || decision.amountToCharge === null) {
      for (const issue of decision.issues) log.warn(`missing: ${issue.code} — ${issue.message}`)
      log.warn('Decision is not final: nothing is charged and no invoice is issued.')
      return null
    }

    // K.4 — Charge exactly what was decided, in the decided currency.
    const amountToCharge = decision.amountToCharge
    const currency = decision.currency
    log.info(`Charge ${eur(amountToCharge)} ${currency.toUpperCase()} — decided, not computed here`)

    // K.5 — Carry the decision id with the settlement, whatever the means.
    // Every settlement has a reference: a transfer wording, a direct-debit
    // mandate reference, a cheque number, a PSP charge id. That reference is
    // what lets step K.7 verify what was actually received.
    const settlement = {
      amount: amountToCharge,
      currency,
      // transfer, card, check, cash, direct_debit, sepa, paypal or other
      method: 'transfer' as const,
      reference: decision.id,
      paidAt: isoDate(),
      customerId: customer.id,
    }
    log.info(`Settlement reference ${settlement.reference} — ${eur(settlement.amount)} by ${settlement.method}`)

    // K.5b — OPTIONAL, for a PSP-collected payment. Two examples, nothing more:
    // Facturino requires neither. Simulated locally — no call is made.
    log.info(
      `Optional PSP variants — Stripe metadata ${JSON.stringify({ facturino_tax_decision_id: decision.id })}` +
        ` | PayPal custom_id=${decision.id}, value=${(amountToCharge / 100).toFixed(2)}`,
    )

    // K.6 — Once settled, read the decision back from the reference carried
    // with the payment.
    const source = await this.f.taxDecisions.retrieve(settlement.reference)

    // K.7 — Verify amount, currency and buyer against the decision. A mismatch
    // means the settlement and the invoice would not describe the same operation.
    if (settlement.amount !== source.amountToCharge) throw new Error('settled amount differs from the decision')
    if (settlement.currency !== source.currency) throw new Error('settled currency differs from the decision')
    if (settlement.customerId !== source.customerId) throw new Error('settled buyer differs from the decision')
    log.ok('Settlement matches the decision: amount, currency and buyer')

    // K.8 — The invoice is backed by the decision. No VAT is restated: a
    // decision line is referenced, and the document line carries presentation
    // only (unit, catalogue product).
    const draft = await this.f.invoices.create(
      {
        customerId: source.customerId,
        taxDecisionId: source.id,
        decisionLines: [{ taxLineRef: 'abo-pro', unit: subscription.unit, product: subscription.id }],
        buyer: {
          companyName: customer.name,
          address: customer.address,
          ...(customer.siret ? { siret: customer.siret } : {}),
          ...(customer.vatNumber ? { vatNumber: customer.vatNumber } : {}),
        },
        dates: { issued: isoDate(), due: isoDate(30) },
        payment: this.paymentTerms(),
      },
      { idempotencyKey: idempotencyKey('tax-decision-invoice', source.id) },
    )

    // K.9 — Finalize WITH the collection. The money was received at K.5 and
    // verified at K.7, so the invoice is issued acquitted: the number and the
    // payment are applied in the SAME transaction, and the original Factur-X
    // is rendered on a settled document instead of one that says "to pay".
    // The collection is refused (`payment_exceeds_amount_due`) if it exceeds
    // what is due, and the invoice then stays a draft — no number is burned.
    const invoice = await this.f.invoices.finalize(
      draft.id,
      {
        payment: {
          amount: settlement.amount,
          method: settlement.method,
          reference: settlement.reference,
          paidAt: settlement.paidAt,
        },
      },
      { idempotencyKey: idempotencyKey('tax-decision-invoice-fin', draft.id) },
    )
    log.ok(`Invoice ${invoice.number} — taxSource=${invoice.taxSource}`)

    // K.10 — Send to the platform ONLY on the channel the decision states.
    if (source.invoiceChannel === 'einvoicing') {
      await this.f.invoices.send(invoice.id, { idempotencyKey: idempotencyKey('tax-decision-send', invoice.id) })
      log.ok('Sent to the connected platform (invoiceChannel = einvoicing)')
    } else {
      // Not a failure: the operation is simply outside the e-invoicing channel.
      // Attempting `invoices.send` here would be refused, and rightly so.
      log.info(`invoiceChannel=${source.invoiceChannel ?? 'none'} — no platform deposit; the obligation, if any, goes through e-reporting`)
    }

    // K.11 — Keep the reporting axes: they are the obligations, and they hold
    // whether or not the invoice travelled the network.
    log.info(
      `Axes — transaction=${source.transactionReporting ?? 'none'} ` +
        `| payment=${source.paymentReporting ?? 'none'}`,
    )
    for (const reason of source.obligationReasons) {
      log.info(`  ${reason.axis}: ${reason.code} (${reason.reference})`)
    }
    if (source.foreignTaxReviewRequired) {
      // Facturino decides French VAT and the matching French obligations only.
      log.warn('foreignTaxReviewRequired: a foreign tax may apply — review it outside Facturino')
    }

    // K.12 — Read the ledger back. Nothing is recorded here: the collection
    // was applied with the finalization, so this only proves it is there, with
    // the reference that carries the decision id.
    const ledger = await this.f.invoices.payments.list(invoice.id)
    for (const entry of ledger.data) {
      log.ok(`Collection on the ledger — ${eur(entry.amount)} by ${entry.method}, reference ${entry.reference}`)
    }

    // Three status axes, read off the invoice AS ISSUED — already settled.
    log.info(
      `Invoice axes — document=${invoice.documentStatus ?? invoice.status} ` +
        `| transmission=${invoice.transmissionStatus ?? 'not_applicable'} ` +
        `| payment=${invoice.paymentStatus ?? 'unpaid'} (expected paid)`,
    )
    log.info(`Settled on ${invoice.dates.paidAt ?? '—'} — dates.paidAt is the REAL collection date`)
    return invoice
  }

  /**
   * K.11b — Deposit invoice (386) then balance invoice, decision-backed.
   *
   * The order matters and is the point of this block: a deposit is deducted as
   * PREPAID (BT-113), and an amount is only prepaid once it has actually been
   * collected. So the deposit is decided, then ISSUED SETTLED — finalization
   * and full payment in one call — before it is attached to the balance
   * invoice. A deposit that is merely finalized has been invoiced, not paid,
   * and presenting it as prepaid would overstate what the buyer already
   * settled; issued acquitted, the deposit never exists in that state at all.
   *
   * Deposits and schedule are settled SERVER-SIDE against the decided amount:
   * the deposit seeds `amountPaid` (BT-113) and lowers `amountDue` (BT-115),
   * and the instalments must distribute exactly what remains due.
   */
  async depositAndSchedule(customer: Customer, service: Product): Promise<void> {
    log.step('K', 'Deposit and payment schedule')

    // 1. Decide the deposit operation (type 386): a `deposit` line names the
    //    principal supply it follows through `relatedCategory`.
    const depositDecision = await this.decide(customer, [{
      reference: 'acompte-svc',
      description: `${service.name} — acompte`,
      category: 'deposit',
      relatedCategory: 'services',
      rateCategory: 'standard',
      unitAmount: 24_000, // 240,00 € HT — 30 % of the 800,00 € engagement
      quantity: '1',
    }], 'deposit', customer.id)
    if (!depositDecision || depositDecision.amountToCharge === null) return

    const depositDraft = await this.f.invoices.create(
      {
        ...this.invoiceBodyFromDecision(customer, depositDecision.id, [
          { taxLineRef: 'acompte-svc', unit: 'unit' },
        ]),
        type: 'deposit',
      },
      { idempotencyKey: idempotencyKey('deposit-draft', customer.id) },
    )

    // 2. Finalize WITH the payment IN FULL — exactly the decided amount, in a
    //    single call. An amount is only prepaid once it has been collected, and
    //    issuing the deposit acquitted is the strongest form of that rule: the
    //    deposit never exists unpaid, so it can never be deducted before it was
    //    settled.
    const deposit = await this.f.invoices.finalize(
      depositDraft.id,
      {
        payment: {
          amount: depositDecision.amountToCharge,
          method: 'transfer',
          reference: depositDecision.id,
          paidAt: isoDate(),
        },
      },
      { idempotencyKey: idempotencyKey('deposit-final', depositDraft.id) },
    )
    log.ok(`Deposit ${deposit.number} — ${eur(depositDecision.amountToCharge)} issued settled`)

    // 3. The settlement is read off the ISSUED deposit, not fetched afterwards.
    if ((deposit.paymentStatus ?? deposit.status) !== 'paid') {
      // Attaching an unsettled deposit would misstate BT-113.
      log.warn(`Deposit ${deposit.number} is not settled — not attaching it to the balance invoice`)
      return
    }
    log.ok(
      `Deposit ${deposit.number} settled on ${deposit.dates.paidAt ?? '—'} ` +
        '— it may now be deducted as prepaid (BT-113)',
    )

    // 4. Decide the balance operation, then create the invoice deducting the
    //    SETTLED deposit and splitting what remains into instalments. The
    //    decided amountToCharge is untouched; the instalments distribute
    //    exactly the amount still due, and the last one falls on the invoice
    //    due date (BT-9).
    const balanceDecision = await this.decide(
      customer, [this.serviceDecisionLine('10')], 'balance', deposit.id,
    )
    if (!balanceDecision || balanceDecision.amountToCharge === null) return
    const stillDue = balanceDecision.amountToCharge - depositDecision.amountToCharge
    const firstInstalment = Math.floor(stillDue / 2)
    const balanceDraft = await this.f.invoices.create(
      {
        ...this.invoiceBodyFromDecision(customer, balanceDecision.id, [
          { taxLineRef: 'svc-heure', unit: 'hour', product: service.id },
        ]),
        deposits: [{ invoiceId: deposit.id }],
        schedule: [
          { amount: firstInstalment, dueDate: isoDate(15), label: 'Premier versement' },
          { amount: stillDue - firstInstalment, dueDate: isoDate(30), label: 'Solde' },
        ],
      },
      { idempotencyKey: idempotencyKey('balance-draft', deposit.id) },
    )
    const balance = await this.f.invoices.finalize(balanceDraft.id, {
      idempotencyKey: idempotencyKey('balance-final', balanceDraft.id),
    })
    log.ok(
      `Balance invoice ${balance.number} — total ${balance.totals.totalTTC} ` +
        `| prepaid ${balance.totals.amountPaid} | due ${balance.totals.amountDue}`,
    )
  }

  /**
   * K.12 — Credit a DECIDED invoice.
   *
   * `creditedLines` references the decided lines; the rate, the category, the
   * VATEX code and the legal mention are inherited from the invoice's frozen
   * snapshot. Restating them through `items` is refused, and should be.
   */
  async decidedCreditNote(invoice: Invoice): Promise<void> {
    if (invoice.taxDecisionId === undefined) {
      // Every invoice this scenario creates is decision-backed; only a
      // pre-stable fixture could lack one, and crediting it is refused.
      log.warn('Invoice carries no decision — crediting it would be refused (tax_decision_required)')
      return
    }

    const creditNote = await this.f.creditNotes.create(
      {
        relatedInvoiceId: invoice.id,
        creditNoteType: 'partial',
        reasonCode: 'quality',
        reason: 'Partial credit on a decided invoice',
        // Either `quantity` or `amountTTC`, never both. Omitting both credits
        // the line's whole remaining balance.
        creditedLines: [{ taxLineRef: 'abo-pro', amountTTC: 1200 }],
        dates: { issued: isoDate() },
      },
      { idempotencyKey: idempotencyKey('decided-credit-note', invoice.id) },
    )
    log.ok(`Credit note ${creditNote.id} — inherits decision ${creditNote.originalTaxDecisionId ?? invoice.taxDecisionId}`)
  }

  /**
   * K.13 — A recurrence on the decided journey.
   *
   * `taxInputs` carries the OPERATION, not a decision: a recurrence never
   * stores one. Each occurrence is decided on its own effective date, so a
   * schedule created today does not carry this quarter's rules into next year.
   */
  async decidedRecurring(customer: Customer, subscription: Product): Promise<void> {
    const recurring = await this.f.recurringInvoices.create(
      {
        customerId: customer.id,
        frequency: 'monthly',
        startDate: isoDate(),
        nextGenerationDate: isoDate(30),
        taxInputs: {
          taxSource: 'facturino',
          priceMode: 'tax_exclusive',
          lines: [{
            reference: 'abo-pro',
            description: subscription.name,
            category: 'electronically_supplied_services',
            rateCategory: 'standard',
            unitAmount: 9900,
            quantity: '1',
            unit: subscription.unit,
            product: subscription.id,
          }],
        },
        // `templateInvoice` carries presentation and terms only — never a
        // line, never a rate.
        templateInvoice: { paymentTermsDays: 30 },
      },
      { idempotencyKey: idempotencyKey('decided-recurring', customer.id) },
    )
    log.ok(`Recurrence ${recurring.id} — every occurrence is decided on its own date`)
  }

  /**
   * K.14 — The OTHER fiscal journey: the VAT is supplied by the integration.
   *
   * An ERP, a marketplace engine or an in-house rules service that already
   * determines the VAT declares it on the decision (`taxSource: 'integration'`)
   * instead of asking Facturino to determine it. Facturino validates the
   * coherence of what is supplied and refuses contradictions
   * (`integration_vat_incoherent`) — it never silently corrects a rate. The
   * decision, the invoice and the reporting obligations then work exactly as
   * on the `facturino` source: the two journeys are equals.
   */
  async integrationDecision(customer: Customer): Promise<void> {
    log.step('K', 'Integration-supplied VAT')

    const decision = await this.f.taxDecisions.create(
      {
        taxSource: 'integration',
        customerId: customer.id,
        effectiveAt: isoDate(),
        currency: 'eur',
        priceMode: 'tax_exclusive',
        lines: [{
          reference: 'conseil-integ',
          description: 'Prestation de conseil (TVA fournie par l’ERP)',
          category: 'services',
          unitAmount: 10_000,
          quantity: '1',
          vatRate: 2000, // 20,00 % — concluded by YOUR system, never corrected
          vatCode: 'S',
        }],
      },
      { idempotencyKey: idempotencyKey('integration-decision', customer.id) },
    )
    if (decision.status !== 'final' || decision.amountToCharge === null) {
      for (const issue of decision.issues) log.warn(`missing: ${issue.code} — ${issue.message}`)
      return
    }
    log.ok(`Integration decision ${decision.id} — ${eur(decision.amountToCharge)} (taxSource=${decision.taxSource})`)

    // The invoice is created from the decision exactly as on the facturino
    // source — same contract, same axes, same obligations engine.
    const draft = await this.f.invoices.create(
      this.invoiceBodyFromDecision(customer, decision.id, [
        { taxLineRef: 'conseil-integ', unit: 'unit' },
      ]),
      { idempotencyKey: idempotencyKey('integration-invoice', decision.id) },
    )
    const invoice = await this.f.invoices.finalize(draft.id, {
      idempotencyKey: idempotencyKey('integration-invoice-fin', draft.id),
    })
    log.ok(`Invoice ${invoice.number} — taxSource=${invoice.taxSource}`)

    // A contradiction is refused, never corrected: a positive rate cannot
    // carry an exemption code.
    try {
      await this.f.taxDecisions.create(
        {
          taxSource: 'integration',
          customerId: customer.id,
          effectiveAt: isoDate(),
          currency: 'eur',
          priceMode: 'tax_exclusive',
          lines: [{
            reference: 'incoherent',
            description: 'Ligne incohérente (démonstration du refus)',
            category: 'services',
            unitAmount: 10_000,
            quantity: '1',
            vatRate: 2000,
            vatCode: 'S',
            vatexCode: 'VATEX-EU-G',
          }],
        },
        { idempotencyKey: idempotencyKey('integration-incoherent', customer.id, isoDate()) },
      )
      log.warn('Incoherent supplied VAT was NOT refused — this should not happen')
    } catch (err) {
      log.ok(`Contradiction refused, never corrected: ${describeError(err)}`)
    }
  }

  /** Commercial line of the subscription, for a tax decision (no rate stated). */
  private subscriptionDecisionLine(product: Product): TaxDecisionLineParam {
    return {
      reference: 'abo-mensuel',
      description: product.name,
      // A subscription delivered online is an electronically supplied service:
      // it carries its own place-of-supply rules.
      category: 'electronically_supplied_services',
      rateCategory: 'standard',
      unitAmount: 9900, // 99,00 € in integer cents
      quantity: '1', // decimal STRING, never a float
    }
  }

  /** Commercial line of the hourly service, for a tax decision. */
  private serviceDecisionLine(quantity: string): TaxDecisionLineParam {
    return {
      reference: 'svc-heure',
      description: 'Prestation atelier (à l’heure)',
      category: 'services',
      rateCategory: 'standard',
      unitAmount: 8000, // 80,00 €
      quantity,
    }
  }

  /**
   * Build a QUOTE line for the hourly service product. A quote is a commercial
   * document with an INDICATIVE VAT; converting it to an invoice goes through
   * a tax decision, which re-decides the VAT.
   */
  private serviceLine(product: Product, quantity: string): InvoiceLineItemParam {
    return {
      description: product.name,
      quantity,
      unit: 'hour',
      unitPrice: 8000, // 80,00 €
      vatRate: 2000, // indicative on a quote; the decision concludes
      vatCode: 'S',
      product: product.id,
    }
  }

  /** Payment terms shared by every invoice the scenario issues (BT-20, L441-10). */
  private paymentTerms() {
    return {
      terms: 'Paiement à 30 jours',
      termsDays: 30,
      method: 'transfer' as const,
      latePaymentRate: '10.00',
      collectionFee: '40.00',
    }
  }

  /**
   * Take a decision (taxSource `facturino`) on the given commercial lines.
   * Returns null — after logging what is missing — unless the decision is
   * final: `pending_verification` means "cannot conclude yet", never "0".
   */
  private async decide(
    customer: Customer,
    lines: TaxDecisionLineParam[],
    ...keyParts: string[]
  ): Promise<TaxDecision | null> {
    const decision = await this.f.taxDecisions.create(
      {
        taxSource: 'facturino',
        customerId: customer.id,
        effectiveAt: isoDate(),
        currency: 'eur',
        priceMode: 'tax_exclusive',
        lines,
      },
      { idempotencyKey: idempotencyKey('decision', ...keyParts) },
    )
    if (decision.status !== 'final') {
      for (const issue of decision.issues) log.warn(`missing: ${issue.code} — ${issue.message}`)
      return null
    }
    return decision
  }

  /**
   * Assemble a decision-backed invoice-create body (buyer BG-7 from the
   * customer). The document lines reference the decided lines and carry
   * presentation only — the VAT comes from the decision.
   */
  private invoiceBodyFromDecision(
    customer: Customer,
    taxDecisionId: string,
    decisionLines: DecisionBackedLineParam[],
    extra?: { purchaseOrderNumber?: string; notes?: string },
  ) {
    return {
      customerId: customer.id,
      type: 'standard' as const,
      taxDecisionId,
      decisionLines,
      // Buyer block (BG-7). Only set siret/vatNumber when the customer carries
      // them — under exactOptionalPropertyTypes an explicit `undefined` is not
      // the same as an absent optional field.
      buyer: {
        companyName: customer.name,
        address: customer.address,
        ...(customer.siret ? { siret: customer.siret } : {}),
        ...(customer.vatNumber ? { vatNumber: customer.vatNumber } : {}),
      },
      dates: { issued: isoDate(), due: isoDate(30) },
      payment: this.paymentTerms(),
      ...(extra?.purchaseOrderNumber ? { purchaseOrderNumber: extra.purchaseOrderNumber } : {}),
      ...(extra?.notes ? { notes: extra.notes } : {}),
    }
  }

  /**
   * Several document endpoints return either a ready signed URL or an async
   * job. Resolve the union, polling the job until it completes.
   */
  private async documentUrlOrJob(
    label: string,
    fetcher: () => Promise<DocumentUrlResponse | JobResponse>,
  ): Promise<void> {
    try {
      const result = await fetcher()
      if (isJobResponse(result)) {
        log.info(`${label}: async job ${result.id}, polling…`)
        const job = await this.f.jobs.poll(result.id, 1500, 10)
        log.ok(`${label}: job ${job.status}${job.url ? ` (${job.url})` : ''}`)
      } else {
        log.ok(`${label}: URL ready (expires in ${result.expires_in}s)`)
      }
    } catch (err) {
      log.warn(`${label}: ${describeError(err)}`)
    }
  }

  /**
   * In test mode, force the PA status chain so the webhook flow is
   * deterministic: deposited → transmitted → available → received → approved.
   * Each transition triggers the matching webhook on the registered endpoint.
   */
  private async driveePaStatuses(invoiceId: string): Promise<void> {
    if (!SANDBOX(this.config.apiKey)) {
      log.info('Live key: skipping sandbox.simulateStatus (waiting for the real PA)')
      return
    }
    const chain = ['deposited', 'transmitted', 'available', 'received', 'approved'] as const
    for (const status of chain) {
      try {
        await this.f.sandbox.simulateStatus(invoiceId, { status }, {
          idempotencyKey: idempotencyKey('simulate', invoiceId, status),
        })
        log.info(`  → simulated PA status ${status}`)
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) {
          // Transition not allowed from the current state — stop the chain.
          log.warn(`simulateStatus ${status}: ${describeError(err)}`)
          break
        }
        throw err
      }
    }
  }
}

/**
 * Run the entire A→K scenario in order. Each phase logs its progress.
 */
export async function runScenario(f: Facturino, config: Config): Promise<void> {
  const scenario = new Scenario(f, config)

  const { account, company } = await scenario.bootstrap()
  const { subscription, service } = await scenario.catalogue()
  const customer = await scenario.customer()

  const { draft: draftFromQuote, quoteId } = await scenario.quoteToInvoice(customer, service)
  await scenario.validateUpstream(customer, service)

  const invoice = await scenario.invoiceLifecycle(
    company,
    customer,
    draftFromQuote,
    quoteId,
  )
  await scenario.recurring(customer, subscription)
  const decidedInvoice = await scenario.taxDecision(customer, subscription)
  await scenario.depositAndSchedule(customer, service)
  if (decidedInvoice) await scenario.decidedCreditNote(decidedInvoice)
  await scenario.decidedRecurring(customer, subscription)
  await scenario.integrationDecision(customer)
  await scenario.creditNote(customer, invoice, service)
  await scenario.purchases()
  await scenario.webhooks()
  await scenario.accounting()
  await scenario.administration(account, company)
  await scenario.coverage(company, customer, subscription, service, invoice)

  log.step('✓', 'Scenario complete')
}
