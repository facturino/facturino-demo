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
  DocumentUrlResponse,
  JobResponse,
} from '@facturino/node'

import type { Config } from './config.js'
import { describeError, eur, idempotencyKey, isJobResponse, isoDate, isoDateTime, currentPeriod, log } from './lib.js'

/**
 * The shared "Atelier Dupont" scenario, end to end (steps A→J of
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

  /** C.8 — Upstream validation: run EN16931 validation on a payload without emitting. */
  async validateUpstream(customer: Customer, service: Product): Promise<void> {
    log.step('C', 'Upstream validation (validate.run)')

    // Dry-run the full invoice payload against EN16931 + CIUS-FR before
    // creating anything — nothing is persisted. (The customer's SIRET/VAT were
    // already resolved upstream via customers.lookup in the catalogue step.)
    const invoicePayload = this.invoiceCreateBody(customer, [this.serviceLine(service, '2')])
    const result = await this.f.validate.run(invoicePayload)
    log.ok(`Invoice payload valid=${result.valid}, ${result.warnings.length} warning(s)`)
  }

  // ---------------------------------------------------------------------------
  // D. Invoice lifecycle
  // ---------------------------------------------------------------------------

  /**
   * D.9 → D.15 — finalize, fetch documents, deposit to PA, take payment,
   * remind, audit, clone. Uses the draft produced by the quote conversion;
   * if it carries no usable lines, falls back to a fresh draft.
   */
  async invoiceLifecycle(
    company: Company,
    customer: Customer,
    subscription: Product,
    draftFromQuote: Invoice,
    sourceQuoteId: string,
  ): Promise<Invoice> {
    log.step('D', 'Invoice lifecycle')

    // D.9 — Trace invoices issued from the converted quote (filter convertedFrom).
    const fromQuote = await this.f.invoices.list({ convertedFrom: sourceQuoteId, limit: 5 })
    log.info(`invoices.list convertedFrom=${sourceQuoteId}: ${fromQuote.data.length} invoice(s)`)

    // D.9 — Create a fresh invoice carrying both buyer detail (BG-7) and a
    // purchase order number (BT-13), so finalization is fully populated.
    let invoice = await this.f.invoices.create(
      this.invoiceCreateBody(customer, [this.subscriptionLine(subscription)], {
        purchaseOrderNumber: 'PO-2026-0042',
        notes: 'Facture démo Atelier Dupont',
      }),
      { idempotencyKey: idempotencyKey('invoice', customer.id, subscription.id) },
    )
    log.ok(`Draft invoice ${invoice.id} (${invoice.status}); quote draft was ${draftFromQuote.id}`)

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

    const recurring = await this.f.recurringInvoices.create(
      {
        customerId: customer.id,
        frequency: 'monthly',
        startDate: isoDate(),
        nextGenerationDate: isoDate(30),
        autoFinalize: true,
        autoSend: false,
        templateInvoice: {
          items: [this.subscriptionLine(subscription)],
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
      creditNote = await this.f.creditNotes.create(
        {
          customerId: customer.id,
          relatedInvoiceId: invoice.id,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Geste commercial — heure de prestation offerte',
          items: [this.serviceLine(service, '1')],
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

    // J.30 — RGPD: request a data export, then fetch a short-lived download URL.
    try {
      const exportReq = await this.f.account.requestExport()
      log.ok(`RGPD export ready ${exportReq.id} (expires ${exportReq.expires_at})`)
      const dl = await this.f.account.downloadExport(exportReq.id)
      log.info(`Download URL ready (expires ${dl.expires_at})`)
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
   * Exercises every remaining business endpoint not already shown in A→J, so the
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
    try {
      const list = await this.f.creditNotes.list({ limit: 5 })
      log.info(`creditNotes.list: ${list.data.length} item(s)`)
      const draft = await this.f.creditNotes.create(
        {
          customerId: customer.id,
          relatedInvoiceId: invoice.id,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Coverage credit note (draft)',
          items: [this.serviceLine(service, '1')],
          dates: { issued: isoDate() },
        },
        { idempotencyKey: idempotencyKey('cov-credit-note-draft', invoice.id) },
      )
      await this.f.creditNotes.get(draft.id)
      await this.f.creditNotes.update(draft.id, { notes: 'Coverage update' })
      await this.f.creditNotes.del(draft.id)

      const finalDraft = await this.f.creditNotes.create(
        {
          customerId: customer.id,
          relatedInvoiceId: invoice.id,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Coverage credit note (finalized)',
          items: [this.serviceLine(service, '1')],
          dates: { issued: isoDate() },
        },
        { idempotencyKey: idempotencyKey('cov-credit-note-final', invoice.id) },
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
      const draft = await this.f.invoices.create(
        this.invoiceCreateBody(customer, [this.subscriptionLine(subscription)]),
        { idempotencyKey: idempotencyKey('cov-invoice-draft') },
      )
      await this.f.invoices.update(draft.id, { notes: 'Coverage update' })
      await this.f.invoices.del(draft.id)

      const paid = await this.f.invoices.create(
        this.invoiceCreateBody(customer, [this.subscriptionLine(subscription)]),
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

      const toCancel = await this.f.invoices.create(
        this.invoiceCreateBody(customer, [this.subscriptionLine(subscription)]),
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
          templateInvoice: { items: [this.subscriptionLine(subscription)], paymentMethod: 'transfer', paymentTermsDays: 30 },
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

    // Webhook endpoint — get / update / delete on a throwaway.
    try {
      const wh = await this.f.webhookEndpoints.create(
        { url: 'https://example.test/coverage-webhook', description: 'Coverage throwaway', events: ['invoice.finalized'] },
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
  private subscriptionLine(product: Product): InvoiceLineItemParam {
    return {
      description: product.name,
      quantity: '1',
      unit: product.unit,
      unitPrice: 9900, // 99,00 € in cents
      vatRate: 2000, // 20,00 % in centipercent
      vatCode: 'S',
      product: product.id,
    }
  }

  /** Build an invoice/quote line for the hourly service product. */
  private serviceLine(product: Product, quantity: string): InvoiceLineItemParam {
    return {
      description: product.name,
      quantity,
      unit: 'hour',
      unitPrice: 8000, // 80,00 €
      vatRate: 2000,
      vatCode: 'S',
      product: product.id,
    }
  }

  /** Assemble a full invoice-create body (buyer BG-7 from the customer). */
  private invoiceCreateBody(
    customer: Customer,
    lines: InvoiceLineItemParam[],
    extra?: { purchaseOrderNumber?: string; notes?: string },
  ) {
    return {
      customerId: customer.id,
      type: 'standard' as const,
      lines,
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
      payment: {
        terms: 'Paiement à 30 jours',
        termsDays: 30,
        method: 'transfer' as const,
        latePaymentRate: '10.00',
        collectionFee: '40.00',
      },
      // e-invoicing format/profile are derived server-side from company
      // settings; they are read-only on the invoice and not set at creation.
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
 * Run the entire A→J scenario in order. Each phase logs its progress.
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
    subscription,
    draftFromQuote,
    quoteId,
  )
  await scenario.recurring(customer, subscription)
  await scenario.creditNote(customer, invoice, service)
  await scenario.purchases()
  await scenario.webhooks()
  await scenario.accounting()
  await scenario.administration(account, company)
  await scenario.coverage(company, customer, subscription, service, invoice)

  log.step('✓', 'Scenario complete')
}
