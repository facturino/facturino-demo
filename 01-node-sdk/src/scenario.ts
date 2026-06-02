import type Facturino from '@facturino/node'
import { ApiError, ConflictError, NotFoundError, PlanLimitError } from '@facturino/node'
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
import { describeError, idempotencyKey, isJobResponse, isoDate, currentPeriod, log } from './lib.js'

/**
 * The shared "Atelier Dupont" scenario, end to end (steps A→J of
 * docs/SCENARIO.md), driven through the official `@facturino/node` SDK.
 *
 * Design choices:
 *  - Idempotent: lookup-or-create on the customer, reuse of an existing draft
 *    via stable `Idempotency-Key`s, so the whole run is replayable.
 *  - Deterministic in test mode: PA status transitions are forced with
 *    `sandbox.simulateStatus` instead of waiting for a real platform.
 *  - Destructive / billing-mutating calls (account deletion, real Stripe
 *    checkout, member revoke, billing plan change, PA disconnect…) are CODED
 *    but guarded behind explicit flags so a normal run cannot wreck a real
 *    account.
 */

/** Toggle the sensitive, side-effecting calls. All default OFF. */
export interface RunFlags {
  /** Allow account.scheduleDeletion (RGPD art. 17). Reversible for 30 days but still disruptive. */
  allowAccountDeletion?: boolean
  /** Allow billing.checkout / billing.updateSubscription / pause / resume (changes the paid plan). */
  allowBillingMutations?: boolean
  /** Allow members.revoke and apiKeys.revoke (removes real access). */
  allowMemberMutations?: boolean
  /** Allow companies.disconnectPA (drops the BYOPA connection). */
  allowPaDisconnect?: boolean
}

const SANDBOX = (key: string): boolean => key.startsWith('fac_test_')

export class Scenario {
  constructor(
    private readonly f: Facturino,
    private readonly config: Config,
    private readonly flags: RunFlags = {},
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

    // Invoicing settings (numbering prefix, default VAT) + VAT regime.
    await this.f.companies.updateInvoicingSettings(company.id, {
      prefix: 'AD-',
      yearlyReset: true,
      vatRegime: 'normal',
    })
    log.ok('Invoicing settings updated (prefix AD-, yearly reset, normal VAT regime)')

    // Accounting + reminder settings (used by FEC export and dunning).
    await this.f.settings.updateAccounting(company.id, { journalCode: 'VE' })
    await this.f.settings.updateReminders(company.id, {
      enabled: true,
      intervals: [7, 15, 30], // J+7 / J+15 / J+30
    })
    log.ok('Accounting + reminder settings updated')

    // Reference data an integration uses to power its own company/customer forms.
    const legalForms = await this.f.reference.listLegalForms({ search: 'SAS', limit: 3 })
    const nafCodes = await this.f.reference.listNafCodes({ search: 'conseil', limit: 3 })
    log.info(
      `Reference data: ${legalForms.data.length} legal forms, ${nafCodes.data.length} NAF codes`,
    )

    // A.3 — Connect a PA (BYOPA). The client brings their own credentials.
    // testPAConnection is a non-destructive health check, always run.
    try {
      await this.f.companies.connectPA(company.id, {
        provider: 'afnor_generic',
        apiKey: 'demo-pa-credential',
      })
      log.ok('PA connected (afnor_generic, demo credential)')
    } catch (err) {
      // Already connected / not entitled on this plan — non-fatal for the demo.
      log.warn(`connectPA skipped: ${describeError(err)}`)
    }
    try {
      const health = await this.f.companies.testPAConnection(company.id)
      log.info(`PA health check: healthy=${health.healthy} latency=${health.latencyMs}ms`)
    } catch (err) {
      log.warn(`testPAConnection: ${describeError(err)}`)
    }

    // A.4 — Quotas: consumption vs plan limits.
    const usage = await this.f.usage.retrieve()
    log.info(`Usage period ${usage.period.start} → ${usage.period.end} (plan ${usage.plan})`)

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
    log.ok(`Product (subscription) ${subscription.id} — ${subscription.unitPrice} €/mo`)

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
    log.ok(`Product (service) ${service.id} — ${service.unitPrice} €/h`)

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
        validityDays: 30,
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

    // Identifier checks.
    const siret = await this.f.validate.run({ kind: 'siret', value: customer.siret ?? '' })
    log.info(`validate SIRET: valid=${siret.valid}`)

    // Full invoice payload against EN16931 + CIUS-FR, nothing is created.
    const invoicePayload = this.invoiceCreateBody(customer, [this.serviceLine(service, '2')])
    const result = await this.f.validate.run({
      kind: 'invoice',
      invoice: invoicePayload as unknown as Record<string, unknown>,
    })
    log.ok(`Invoice payload valid=${result.valid}, ${result.errors.length} error(s)`)
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
      const link = await this.f.invoices.createPaymentLink(
        invoice.id,
        { success_url: `${this.config.publicBaseUrl}/paid`, cancel_url: `${this.config.publicBaseUrl}/cancel` },
        { idempotencyKey: idempotencyKey('payment-link', invoice.id) },
      )
      log.info(`Payment link: ${link.url}`)
    } catch (err) {
      log.warn(`createPaymentLink (Pro plan): ${describeError(err)}`)
    }
    try {
      const portal = await this.f.invoices.createPortalLink(invoice.id, {
        idempotencyKey: idempotencyKey('portal-link', invoice.id),
      })
      log.info(`Client portal link expires at ${portal.expires_at}`)
    } catch (err) {
      log.warn(`createPortalLink: ${describeError(err)}`)
    }

    // Record a manual payment of the full amount, then list payments.
    try {
      const amountDue = Math.round(Number.parseFloat(invoice.totals.amountDue) * 100)
      const payment = await this.f.invoices.payments.create(
        invoice.id,
        { amount: amountDue || 11880, method: 'transfer', reference: 'VIR-2026-0042', paidAt: isoDate() },
        { idempotencyKey: idempotencyKey('payment', invoice.id) },
      )
      log.ok(`Payment ${payment.id} recorded (${payment.amount} €)`)
      const payments = await this.f.invoices.payments.list(invoice.id)
      log.info(`payments.list: ${payments.data.length} payment(s)`)
    } catch (err) {
      log.warn(`payments.create: ${describeError(err)}`)
    }

    // D.13 — Reminder + lifecycle events.
    try {
      await this.f.invoices.remind(invoice.id, { idempotencyKey: idempotencyKey('remind', invoice.id) })
      log.ok('Reminder requested')
    } catch (err) {
      log.warn(`remind: ${describeError(err)}`)
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
    const list = await this.f.recurringInvoices.list({ active: true, limit: 5 })
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
          senderSiret: '40483304800022',
          senderName: 'Fournisseur Démo SARL',
          number: 'F-SUP-2026-118',
          issuedAt: isoDate(-5),
          dueAt: isoDate(25),
          totalHT: 50000,
          totalTVA: 10000,
          totalTTC: 60000,
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
        paidAt: isoDate(),
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

  /** I.22 → I.26 — reporting, exports, e-reporting, archives, product notifications. */
  async accounting(): Promise<void> {
    log.step('I', 'Accounting & steering')

    const periodStart = `${currentPeriod()}-01`
    const periodEnd = isoDate()

    // I.22 — VAT + revenue reports (Essential+).
    try {
      const vat = await this.f.reporting.vatReport({ period_start: periodStart, period_end: periodEnd })
      log.info(`VAT report: total_ht=${vat.total_ht}, total_vat=${vat.total_vat}, invoices=${vat.invoice_count}`)
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
      const invoicesZip = await this.f.exports.exportInvoices({
        idempotencyKey: idempotencyKey('export-invoices', periodEnd),
      })
      log.info(`Invoices ZIP export job ${invoicesZip.id}`)
    } catch (err) {
      log.warn(`exports.exportInvoices: ${describeError(err)}`)
    }
    try {
      const rgpd = await this.f.exports.exportRgpd({ idempotencyKey: idempotencyKey('export-rgpd', periodEnd) })
      log.info(`RGPD export job ${rgpd.id}`)
      await this.f.exports.getExportStatus(rgpd.id).catch(() => undefined)
    } catch (err) {
      log.warn(`exports.exportRgpd: ${describeError(err)}`)
    }

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

    // I.26 — Product notifications + preferences.
    const notifications = await this.f.notifications.list({ limit: 5, unread: true })
    log.info(`notifications.list (unread): ${notifications.data.length}`)
    const firstNotif = notifications.data[0]
    if (firstNotif) await this.f.notifications.markRead(firstNotif.id)
    await this.f.notifications.markAllRead()
    const prefs = await this.f.notifications.retrievePreferences()
    await this.f.notifications.updatePreferences({
      preferences: { ...prefs.preferences, invoice_paid: { email: true, inApp: true, push: false } },
    })
    log.ok('Notification preferences updated')
  }

  // ---------------------------------------------------------------------------
  // J. Account administration
  // ---------------------------------------------------------------------------

  /** J.27 → J.30 — API keys, members, Facturino billing, RGPD. */
  async administration(account: Account, company: Company): Promise<void> {
    log.step('J', 'Account administration')

    // J.27 — A scoped API key for a worker (read-only invoices + payments).
    try {
      const key = await this.f.apiKeys.create(
        { name: 'demo-worker (read-only)', permissions: ['invoices:read', 'payments:read'] },
        { idempotencyKey: idempotencyKey('api-key', 'demo-worker') },
      )
      log.ok(`API key ${key.id} created (full value returned once: ${key.key ? 'yes' : 'no'})`)
      await this.f.apiKeys.get(key.id)
      const keys = await this.f.apiKeys.list()
      log.info(`apiKeys.list: ${keys.data.length} key(s)`)
      // roll + revoke are destructive — guarded.
      if (this.flags.allowMemberMutations) {
        const rolled = await this.f.apiKeys.roll(key.id)
        log.ok(`API key rolled → ${rolled.id}`)
        await this.f.apiKeys.revoke(rolled.id)
        log.ok('Rolled key revoked')
      } else {
        log.skip('apiKeys.roll / revoke (set allowMemberMutations to enable)')
      }
    } catch (err) {
      log.warn(`apiKeys: ${describeError(err)}`)
    }

    // J.28 — Members.
    try {
      const members = await this.f.members.list(company.id)
      log.info(`members.list: ${members.data.length} member(s)`)
      const invited = await this.f.members.invite(
        company.id,
        { email: 'accountant@atelier-dupont.example', role: 'viewer', displayName: 'Cabinet comptable' },
        { idempotencyKey: idempotencyKey('member', company.id, 'accountant') },
      )
      log.ok(`Member invited ${invited.id} (${invited.role})`)
      await this.f.members.get(company.id, invited.id)
      await this.f.members.updateRole(company.id, invited.id, { role: 'editor' })
      await this.f.members.resendInvitation(company.id, invited.id)
      if (this.flags.allowMemberMutations) {
        await this.f.members.revoke(company.id, invited.id)
        log.ok('Member revoked')
      } else {
        log.skip('members.revoke (set allowMemberMutations to enable)')
      }
    } catch (err) {
      log.warn(`members: ${describeError(err)}`)
    }

    // J.29 — Facturino's own billing (Facturino → user).
    try {
      const subscription = await this.f.billing.retrieveSubscription()
      log.info(`Facturino subscription: plan=${subscription.plan} status=${subscription.status}`)
      const invoices = await this.f.billing.listInvoices({ limit: 5 })
      log.info(`billing.listInvoices: ${invoices.data.length} platform invoice(s)`)
      const firstPlatformInvoice = invoices.data[0]
      if (firstPlatformInvoice) {
        await this.f.billing.getInvoicePdf(firstPlatformInvoice.id).catch(() => undefined)
      }
      if (this.flags.allowBillingMutations) {
        // CODED but guarded: these change the real paid plan / open Stripe.
        const checkout = await this.f.billing.checkout({
          planId: 'pro',
          successUrl: `${this.config.publicBaseUrl}/billing/ok`,
          cancelUrl: `${this.config.publicBaseUrl}/billing/cancel`,
        })
        log.info(`Checkout session: ${checkout.url}`)
        await this.f.billing.updateSubscription({ planId: 'pro', cycle: 'annual' })
        await this.f.billing.pause({ months: 1 })
        await this.f.billing.resume()
        const portal = await this.f.billing.portal({ returnUrl: `${this.config.publicBaseUrl}/billing` })
        log.info(`Customer portal: ${portal.url}`)
      } else {
        log.skip('billing.checkout / updateSubscription / pause / resume / portal (set allowBillingMutations)')
      }
    } catch (err) {
      log.warn(`billing: ${describeError(err)}`)
    }

    // J.30 — RGPD: request + download a data export; update broadcast prefs.
    try {
      const exportReq = await this.f.account.requestExport()
      log.ok(`RGPD export requested ${exportReq.exportId} (${exportReq.status})`)
      if (exportReq.status === 'ready') {
        const dl = await this.f.account.downloadExport(exportReq.exportId)
        log.info(`Download URL ready (expires ${dl.expiresAt})`)
      }
      await this.f.account.updateNotifications({ invoicePaid: true, productNews: false })
      log.ok('Broadcast notification preferences updated')
    } catch (err) {
      log.warn(`account RGPD: ${describeError(err)}`)
    }

    // scheduleDeletion / cancelDeletion — CODED but guarded. Never run by default.
    if (this.flags.allowAccountDeletion) {
      const scheduled = await this.f.account.scheduleDeletion()
      log.warn(`Account deletion scheduled for ${scheduled.deletionScheduledAt}`)
      await this.f.account.cancelDeletion()
      log.ok('Account deletion cancelled (grace window)')
    } else {
      log.skip('account.scheduleDeletion / cancelDeletion (set allowAccountDeletion to enable)')
    }

    void account
  }

  /**
   * Illustrative-only families, kept minimal per the scenario:
   *  - cabinets.list (needs a cabinet_* plan; non-fatal if 402)
   *  - MFA is an app-web concern, documented but not executed here.
   */
  async illustrative(): Promise<void> {
    log.step('J', 'Illustrative (cabinets, MFA)')
    try {
      const cabinets = await this.f.cabinets.list({ limit: 1 })
      log.info(`cabinets.list: ${cabinets.data.length} (requires cabinet_* plan)`)
    } catch (err) {
      if (err instanceof PlanLimitError || err instanceof ApiError) {
        log.skip(`cabinets.list not available on this plan (${describeError(err)})`)
      } else {
        throw err
      }
    }
    // MFA (mfa.setup/verify/disable/generateBackupCodes) is driven by the
    // Facturino web app, not a SaaS-API integration. Documented, not executed.
    log.skip('mfa.* — managed by the Facturino web app, not exercised here')
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
      einvoicing: { format: 'facturx' as const, profile: 'EN16931' as const },
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
        log.ok(`${label}: job ${job.status}${job.download_url ? ` (${job.download_url})` : ''}`)
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
 * Run the entire A→J scenario in order. Each phase logs its progress; sensitive
 * calls are skipped unless the corresponding flag is set.
 */
export async function runScenario(
  f: Facturino,
  config: Config,
  flags: RunFlags = {},
): Promise<void> {
  const scenario = new Scenario(f, config, flags)

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
  await scenario.illustrative()

  log.step('✓', 'Scenario complete')
}
