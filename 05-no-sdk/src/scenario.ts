/**
 * The "Atelier Dupont" scenario — phases A → J.
 *
 * One backend, 100% of its billing through Facturino: bootstrap the account,
 * build a catalogue and a customer, quote → invoice → deposit → payment, a
 * recurring subscription, a credit note, an incoming purchase invoice,
 * webhooks, accounting exports, and account admin.
 *
 * Every call is plain HTTP through {@link FacturinoClient}. Read it next to
 * docs/SCENARIO.md — each `phaseX()` maps to a lettered section there.
 *
 * Conventions enforced here (see CONVENTIONS in SCENARIO.md):
 *   • Amounts are integer CENTS (10000 = €100.00).
 *   • VAT rates are integer HUNDREDTHS OF A PERCENT (2000 = 20.00%).
 *   • Idempotency-Key on every creation POST. Each run draws a fresh run id, so
 *     re-running is safe; within a run the key is stable, so a retried POST
 *     never creates a duplicate.
 *   • Lists are cursor-paginated (starting_after / has_more).
 *   • Errors carry request_id — we log it for support.
 *
 * A few operations transmit to the DGFiP (ereporting.submit) or mutate
 * supplier-invoice state (received-invoice refuse/suspend); they are CODED but
 * kept behind an explicit guard so a run never has irreversible side effects.
 * Set `ALLOW_DESTRUCTIVE=1` to actually fire them.
 */
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { FacturinoClient, FacturinoError, idempotencyKey } from './client.js';
import { phase, step, detail, warn, fail, resetSteps } from './log.js';

/** Set ALLOW_DESTRUCTIVE=1 to run guarded destructive operations. */
const ALLOW_DESTRUCTIVE = process.env['ALLOW_DESTRUCTIVE'] === '1';

/** Minimal shapes for the resources we touch (the API returns much more). */
interface Identified {
  id: string;
}
interface Company extends Identified {
  name?: string;
  einvoicing?: { provider?: string };
}
interface Customer extends Identified {
  name?: string;
}
interface Product extends Identified {
  name?: string;
}
interface Quote extends Identified {
  status?: string;
  number?: string;
}
interface Invoice extends Identified {
  status?: string;
  number?: string | null;
  totals?: { totalTTC?: string; amountDue?: string };
  // Présent uniquement quand on demande ?expand=credit_notes.
  expanded?: {
    credit_notes?: CreditNote[];
    net_balance?: string;
  };
}
interface CreditNote extends Identified {
  status?: string;
  number?: string | null;
}
interface RecurringInvoice extends Identified {
  status?: string;
}
interface WebhookEndpoint extends Identified {
  secret?: string;
  url?: string;
}
interface Job extends Identified {
  status?: string;
  result?: unknown;
}

/** Shared state threaded through the phases (lookup-or-create reuse). */
interface ScenarioContext {
  companyId: string;
  subscriptionProductId?: string;
  consultingProductId?: string;
  customerId?: string;
  quoteId?: string;
  invoiceId?: string;
  invoiceNumber?: string | null;
  creditNoteId?: string;
  recurringId?: string;
  receivedInvoiceId?: string;
  webhookEndpointId?: string;
}

export class Scenario {
  private readonly client: FacturinoClient;
  private readonly config: Config;
  /** Fresh per run() so re-running never collides on a stale Idempotency-Key. */
  private runId = '';

  constructor(config: Config) {
    this.config = config;
    this.client = new FacturinoClient(config);
  }

  /**
   * Build an Idempotency-Key scoped to the current run. Stable across retries
   * of the same logical POST within one run; unique across runs.
   */
  private idem(operation: string, ...parts: string[]): string {
    return idempotencyKey(operation, this.runId, ...parts);
  }

  /** Run the whole A→J parcours. Returns the resulting context. */
  async runAll(): Promise<ScenarioContext> {
    resetSteps();
    this.runId = randomUUID().slice(0, 8);
    const companyId = await this.resolveCompanyId();
    const ctx: ScenarioContext = { companyId };

    await this.phaseA(ctx);
    await this.phaseB(ctx);
    await this.phaseC(ctx);
    await this.phaseD(ctx);
    await this.phaseE(ctx);
    await this.phaseF(ctx);
    await this.phaseG(ctx);
    await this.phaseH(ctx);
    await this.phaseI(ctx);
    await this.phaseJ();

    console.log('\n\x1b[1m\x1b[38;5;46m✓ Scenario complete.\x1b[0m');
    return ctx;
  }

  // ===========================================================================
  // A. Bootstrap du compte SaaS
  // ===========================================================================
  async phaseA(ctx: ScenarioContext): Promise<void> {
    phase('A', 'Bootstrap du compte SaaS');

    // A.1 — account.retrieve: who am I, what plan, test or live?
    step('account.retrieve → GET /account');
    const account = await this.client.get<{
      id?: string;
      plan?: string;
      livemode?: boolean;
      email?: string;
    }>('/account');
    detail(`plan=${account.plan ?? '?'} livemode=${account.livemode ?? this.config.livemode}`);

    // A.2 — companies.list / get.
    step('companies.list → GET /companies');
    const companies = await this.client.list<Company>('/companies', { limit: 10 });
    detail(`${companies.data.length} company(ies)`);

    step(`companies.get → GET /companies/${ctx.companyId}`);
    const company = await this.client.get<Company>(`/companies/${ctx.companyId}`);
    detail(`company=${company.name ?? ctx.companyId}`);

    // A.2b — Company admin: general terms (CGV) round-trip + onboarding milestone.
    step('companies.uploadCgv → POST /companies/:id/cgv');
    try {
      // CGV are sent as a base64-encoded PDF.
      const cgvPdf = Buffer.from('%PDF-1.4\n% Conditions générales de vente (démo)\n').toString('base64');
      await this.client.post(
        `/companies/${ctx.companyId}/cgv`,
        { content: cgvPdf },
        this.idem('cgv', ctx.companyId),
      );
      step('companies.getCgv → GET /companies/:id/cgv (URL signée)');
      await this.client.get(`/companies/${ctx.companyId}/cgv`);
      step('companies.deleteCgv → DELETE /companies/:id/cgv');
      await this.client.delete(`/companies/${ctx.companyId}/cgv`);
      step('companies.addMilestone → POST /companies/:id/milestones');
      await this.client.post(
        `/companies/${ctx.companyId}/milestones`,
        { milestone: 'firstInvoice' },
        this.idem('milestone', ctx.companyId),
      );
      detail('CGV upload/get/delete + jalon firstInvoice');
    } catch (err) {
      this.softError('companies.cgv/milestone', err);
    }

    // A.3 — Reference data (open data).
    step('reference.listLegalForms → GET /reference/legal-forms');
    await this.client.get('/reference/legal-forms');
    step('reference.listNafCodes → GET /reference/naf-codes');
    await this.client.get('/reference/naf-codes');

    // A.4 — usage.retrieve: consumption vs plan limits.
    step('usage.retrieve → GET /usage');
    const usage = await this.client.get<{ counters?: { apiRequestsMonth?: { used?: number; limit?: number | null } } }>(
      '/usage',
    );
    const apiReq = usage.counters?.apiRequestsMonth;
    detail(`API requests: ${apiReq?.used ?? '?'} / ${apiReq?.limit ?? '∞'}`);
  }

  // ===========================================================================
  // B. Catalogue & client
  // ===========================================================================
  async phaseB(ctx: ScenarioContext): Promise<void> {
    phase('B', 'Catalogue & client');

    // B.5 — Products: a monthly subscription + a per-unit consulting service.
    step('products.create (abonnement) → POST /products');
    const subscription = await this.client.post<Product>(
      '/products',
      {
        name: 'Abonnement Atelier — mensuel',
        description: 'Accès plateforme, mises à jour incluses',
        reference: 'SUB-MONTHLY',
        unitPrice: 4900, // 49,00 € HT, en centimes
        vatRate: 2000, // 20,00 %, en centièmes de pourcent
        vatCode: 'S', // taux standard
        unit: 'month',
      },
      this.idem('product', 'SUB-MONTHLY'),
    );
    ctx.subscriptionProductId = subscription.id;
    detail(`product=${subscription.id}`);

    step('products.create (prestation) → POST /products');
    const consulting = await this.client.post<Product>(
      '/products',
      {
        name: 'Prestation de conseil',
        reference: 'CONSULT-H',
        unitPrice: 12000, // 120,00 € HT / heure
        vatRate: 2000,
        vatCode: 'S',
        unit: 'hour',
      },
      this.idem('product', 'CONSULT-H'),
    );
    ctx.consultingProductId = consulting.id;
    detail(`product=${consulting.id}`);

    step('products.list → GET /products (cursor pagination)');
    const products = await this.client.listAll<Product>('/products', { limit: 50 });
    detail(`${products.length} produit(s) au catalogue`);

    // products.list avec filtres: q (recherche par préfixe de nom), category,
    // active. Ici on retrouve l'abonnement via q="abonnement".
    step('products.list (filtres) → GET /products?q=abonnement&active=true');
    try {
      const filtered = await this.client.list<Product>('/products', {
        query: { q: 'abonnement', category: 'subscription', active: true },
      });
      detail(`${filtered.data.length} produit(s) « abonnement » (filtre q + category + active)`);
    } catch (err) {
      this.softError('products.list (filtres)', err);
    }

    step(`products.get → GET /products/${consulting.id}`);
    await this.client.get<Product>(`/products/${consulting.id}`);

    step('products.update → PATCH /products/:id');
    await this.client.patch(`/products/${consulting.id}`, { unitPrice: 13000 }); // 130,00 €

    step('products.exportCsv → GET /products/export');
    const productsCsv = await this.client.get<string>('/products/export');
    detail(`export CSV: ${String(productsCsv).split('\n').length - 1} ligne(s)`);

    step('products.importCsv → POST /products/import');
    try {
      await this.client.post(
        '/products/import',
        {
          csv: 'name,reference,unitPrice,vatRate,vatCode,unit\nFormation,FORM-D,80000,2000,S,day\n',
        },
        this.idem('products.import', 'FORM-D'),
      );
      detail('import CSV OK');
    } catch (err) {
      this.softError('products.importCsv', err);
    }

    // B.6 — Customer: SIRENE/VIES lookup, then lookup-or-create (replayable).
    step('customers.lookup → POST /customers/lookup (SIRENE)');
    try {
      const lookup = await this.client.post<{ found?: boolean; data?: { name?: string } | null }>(
        '/customers/lookup',
        { siret: '55208131766522' },
      );
      detail(`SIRENE: ${lookup.found ? (lookup.data?.name ?? 'trouvé') : 'aucun résultat'}`);
    } catch (err) {
      this.softError('customers.lookup', err);
    }

    step('customers.list → GET /customers (lookup-or-create)');
    const existing = await this.client.listAll<Customer & { siret?: string }>('/customers', {
      limit: 100,
    });
    const found = existing.find((c) => c.siret === '55208131766522');
    if (found) {
      ctx.customerId = found.id;
      detail(`client existant réutilisé: ${found.id}`);
    } else {
      step('customers.create → POST /customers');
      const customer = await this.client.post<Customer>(
        '/customers',
        {
          name: 'Café des Artisans SARL',
          type: 'company',
          // Email principal — destinataire des relances (invoices.remind).
          email: 'compta@cafe-des-artisans.example',
          siret: '55208131766522',
          vatNumber: 'FR40552081317',
          address: {
            line1: '12 rue des Lilas',
            postalCode: '75011',
            city: 'Paris',
            country: 'FR',
          },
          // Contact de facturation: reçoit les factures par défaut (role billing).
          contacts: [{ email: 'compta@cafe-des-artisans.example', role: 'billing' }],
          paymentTerms: 30,
        },
        this.idem('customer', '55208131766522'),
      );
      ctx.customerId = customer.id;
      detail(`client créé: ${customer.id}`);
    }

    step(`customers.get → GET /customers/${ctx.customerId}`);
    await this.client.get<Customer>(`/customers/${ctx.customerId}`);

    step('customers.update → PATCH /customers/:id');
    // Backfill the email too, so a customer reused from an earlier run can
    // still receive reminders (invoices.remind requires it).
    await this.client.patch(`/customers/${ctx.customerId}`, {
      notes: 'Client fidèle depuis 2024',
      email: 'compta@cafe-des-artisans.example',
    });

    step('customers.exportCsv → GET /customers/export');
    await this.client.get<string>('/customers/export');
    step('customers.importCsv → POST /customers/import');
    try {
      await this.client.post(
        '/customers/import',
        {
          csv: 'name,type,siret,line1,postalCode,city,country\nBoulangerie Martin,company,55208131766522,3 av. Gambetta,69003,Lyon,FR\n',
        },
        this.idem('customers.import', '55208131766522'),
      );
    } catch (err) {
      this.softError('customers.importCsv', err);
    }
  }

  // ===========================================================================
  // C. Devis → facture
  // ===========================================================================
  async phaseC(ctx: ScenarioContext): Promise<void> {
    phase('C', 'Devis → facture');
    const customerId = this.requireCustomer(ctx);

    // C.7 — Quote lifecycle: create → send → accept → convert.
    step('quotes.create → POST /quotes');
    const quote = await this.client.post<Quote>(
      '/quotes',
      {
        customerId,
        lines: [
          {
            description: 'Audit initial (forfait)',
            quantity: '1',
            unitPrice: 80000, // 800,00 €
            vatRate: 2000,
            vatCode: 'S',
            unit: 'flat_rate',
          },
          {
            description: 'Conseil sur mesure',
            quantity: '10',
            unitPrice: 13000, // 130,00 €/h
            vatRate: 2000,
            vatCode: 'S',
            unit: 'hour',
          },
        ],
        dates: {
          issued: this.today(),
          validUntil: this.addDays(30),
        },
        notes: 'Devis valable 30 jours.',
      },
      this.idem('quote', customerId, this.today()),
    );
    ctx.quoteId = quote.id;
    detail(`quote=${quote.id} status=${quote.status}`);

    step(`quotes.send → POST /quotes/${quote.id}/send`);
    try {
      await this.client.post(`/quotes/${quote.id}/send`);
    } catch (err) {
      this.softError('quotes.send', err);
    }

    step(`quotes.get → GET /quotes/${quote.id}`);
    await this.client.get<Quote>(`/quotes/${quote.id}`);

    step(`quotes.accept → POST /quotes/${quote.id}/accept`);
    try {
      await this.client.post(`/quotes/${quote.id}/accept`);
      detail('devis accepté');
    } catch (err) {
      this.softError('quotes.accept', err);
    }

    step(`quotes.getPdf → GET /quotes/${quote.id}/pdf`);
    try {
      await this.client.get(`/quotes/${quote.id}/pdf`);
    } catch (err) {
      this.softError('quotes.getPdf', err);
    }

    step(`quotes.getSignatureProof → GET /quotes/${quote.id}/signature-proof`);
    try {
      await this.client.get(`/quotes/${quote.id}/signature-proof`);
    } catch (err) {
      this.softError('quotes.getSignatureProof', err);
    }

    // quotes.clone: re-proposer un devis similaire en brouillon (sans toucher
    // l'original accepté). Idempotent par devis source pour rester rejouable.
    step(`quotes.clone → POST /quotes/${quote.id}/clone (re-proposition en brouillon)`);
    try {
      const cloned = await this.client.post<Quote>(
        `/quotes/${quote.id}/clone`,
        undefined,
        this.idem('quote.clone', quote.id),
      );
      detail(`devis cloné (brouillon): ${cloned.id} status=${cloned.status}`);
    } catch (err) {
      this.softError('quotes.clone', err);
    }

    step(`quotes.convert → POST /quotes/${quote.id}/convert (→ facture brouillon)`);
    try {
      const converted = await this.client.post<Invoice>(`/quotes/${quote.id}/convert`);
      ctx.invoiceId = converted.id;
      detail(`facture brouillon issue du devis: ${converted.id}`);
    } catch (err) {
      this.softError('quotes.convert', err);
    }

    // C.8 — validate.run: dry-run EN16931 validation BEFORE creating anything.
    step('validate.run → POST /validate (validation amont, rien émis)');
    try {
      const validation = await this.client.post<{ valid?: boolean; errors?: unknown[] }>(
        '/validate',
        this.sampleInvoicePayload(customerId),
      );
      detail(`valid=${validation.valid ?? '?'} errors=${validation.errors?.length ?? 0}`);
    } catch (err) {
      this.softError('validate.run', err);
    }
  }

  // ===========================================================================
  // D. Cycle de vie facture
  // ===========================================================================
  async phaseD(ctx: ScenarioContext): Promise<void> {
    phase('D', 'Cycle de vie facture');
    const customerId = this.requireCustomer(ctx);

    // D.9 — Create (or reuse the draft from C.convert), then finalize.
    if (!ctx.invoiceId) {
      step('invoices.create → POST /invoices');
      const invoice = await this.client.post<Invoice>(
        '/invoices',
        this.sampleInvoicePayload(customerId),
        this.idem('invoice', customerId, this.today()),
      );
      ctx.invoiceId = invoice.id;
      detail(`invoice=${invoice.id} status=${invoice.status}`);
    } else {
      detail(`réutilise le brouillon converti depuis le devis: ${ctx.invoiceId}`);
    }
    const invoiceId = ctx.invoiceId;

    step(`invoices.finalize → POST /invoices/${invoiceId}/finalize (numérotation)`);
    try {
      const finalized = await this.client.post<Invoice>(
        `/invoices/${invoiceId}/finalize`,
        undefined,
        // Idempotent finalize: a retried call returns the same number.
        this.idem('finalize', invoiceId),
      );
      ctx.invoiceNumber = finalized.number ?? null;
      detail(`numéro attribué: ${finalized.number ?? '(async)'}`);
    } catch (err) {
      this.softError('invoices.finalize', err);
    }

    step(`invoices.get → GET /invoices/${invoiceId}`);
    const inv = await this.client.get<Invoice>(`/invoices/${invoiceId}`);
    detail(`TTC=${inv.totals?.totalTTC ?? '?'} € · status=${inv.status}`);

    step(`invoices.getStatus → GET /invoices/${invoiceId}/status`);
    await this.client.get(`/invoices/${invoiceId}/status`);

    // invoices.list avec filtre convertedFrom: retrouver les factures issues du
    // devis converti en C.7 (lien devis → facture).
    if (ctx.quoteId) {
      step(`invoices.list (convertedFrom) → GET /invoices?convertedFrom=${ctx.quoteId}`);
      try {
        const fromQuote = await this.client.list<Invoice>('/invoices', {
          query: { convertedFrom: ctx.quoteId },
        });
        detail(`${fromQuote.data.length} facture(s) issue(s) du devis ${ctx.quoteId}`);
      } catch (err) {
        this.softError('invoices.list (convertedFrom)', err);
      }
    }

    // D.10 — Documents. PDF/Factur-X may be async → poll the job.
    step(`invoices.getPdf → GET /invoices/${invoiceId}/pdf (+ jobs.poll si async)`);
    await this.fetchDocumentMaybeAsync(`/invoices/${invoiceId}/pdf`);
    step(`invoices.getFacturx → GET /invoices/${invoiceId}/facturx`);
    await this.fetchDocumentMaybeAsync(`/invoices/${invoiceId}/facturx`);
    step(`invoices.getXml (CII) → GET /invoices/${invoiceId}/xml?format=cii`);
    await this.fetchDocumentMaybeAsync(`/invoices/${invoiceId}/xml`, { format: 'cii' });
    step(`invoices.getXml (UBL) → GET /invoices/${invoiceId}/xml?format=ubl`);
    await this.fetchDocumentMaybeAsync(`/invoices/${invoiceId}/xml`, { format: 'ubl' });

    // D.11 — Deposit to the PA.
    step(`invoices.send → POST /invoices/${invoiceId}/send (dépôt PA)`);
    try {
      await this.client.post(
        `/invoices/${invoiceId}/send`,
        undefined,
        this.idem('invoice.send', invoiceId),
      );
      detail('déposée à la PA');
    } catch (err) {
      this.softError('invoices.send', err);
    }

    // In fac_test_ mode, drive the PA status machine deterministically so the
    // webhook chain fires without waiting on a real platform.
    step(`sandbox.simulateStatus → POST /sandbox/simulate-status/${invoiceId}`);
    for (const status of ['deposited', 'transmitted', 'available', 'received', 'approved']) {
      try {
        await this.client.post(`/sandbox/simulate-status/${invoiceId}`, { status });
      } catch (err) {
        this.softError(`sandbox.simulateStatus(${status})`, err);
        break;
      }
    }
    detail('statut PA simulé → approved');

    // D.12 — Collection: payment link, portal link, then record a payment.
    step(`invoices.createPaymentLink → POST /invoices/${invoiceId}/payment-link (Stripe)`);
    try {
      const link = await this.client.post<{ url?: string }>(
        `/invoices/${invoiceId}/payment-link`,
        {
          success_url: `${this.config.publicBaseUrl || 'https://example.com'}/paid`,
          cancel_url: `${this.config.publicBaseUrl || 'https://example.com'}/cancel`,
        },
        this.idem('payment-link', invoiceId),
      );
      detail(`payment link: ${link.url ?? '(créé)'}`);
    } catch (err) {
      this.softError('invoices.createPaymentLink', err);
    }

    step(`invoices.createPortalLink → POST /invoices/${invoiceId}/portal-link`);
    try {
      await this.client.post(`/invoices/${invoiceId}/portal-link`);
    } catch (err) {
      this.softError('invoices.createPortalLink', err);
    }

    // Signed payment token for an embedded/headless checkout (Pro+).
    step(`invoices.createPaymentToken → POST /invoices/${invoiceId}/payment-token`);
    await this.client
      .post(`/invoices/${invoiceId}/payment-token`)
      .catch((e) => this.softError('invoices.createPaymentToken', e));

    step(`payments.create → POST /invoices/${invoiceId}/payments`);
    try {
      await this.client.post(
        `/invoices/${invoiceId}/payments`,
        {
          amount: 60000, // 600,00 € — partial payment to illustrate partially_paid
          method: 'transfer',
          reference: 'VIR-2026-0001',
          paidAt: new Date().toISOString(),
        },
        this.idem('payment', invoiceId, 'VIR-2026-0001'),
      );
      detail('paiement partiel enregistré');
    } catch (err) {
      this.softError('payments.create', err);
    }

    step(`payments.list → GET /invoices/${invoiceId}/payments`);
    try {
      const payments = await this.client.list<Identified>(`/invoices/${invoiceId}/payments`);
      detail(`${payments.data.length} paiement(s)`);
    } catch (err) {
      this.softError('payments.list', err);
    }

    // D.13 — Reminder + event history.
    step(`invoices.remind → POST /invoices/${invoiceId}/remind`);
    try {
      await this.client.post(
        `/invoices/${invoiceId}/remind`,
        { level: 1, message: 'Petit rappel amical concernant votre facture.' },
        this.idem('remind', invoiceId, '1'),
      );
    } catch (err) {
      this.softError('invoices.remind', err);
    }

    step(`invoices.listEvents → GET /invoices/${invoiceId}/events`);
    try {
      const events = await this.client.list<Identified & { type?: string }>(
        `/invoices/${invoiceId}/events`,
      );
      detail(`${events.data.length} évènement(s) sur la facture`);
    } catch (err) {
      this.softError('invoices.listEvents', err);
    }

    // D.14 — Audit trail (hash chain + PDF).
    step(`invoices.verify → GET /invoices/${invoiceId}/verify (hash chain)`);
    try {
      const verify = await this.client.get<{ verified?: boolean }>(`/invoices/${invoiceId}/verify`);
      detail(`chaîne de hash valide=${verify.verified ?? '?'}`);
    } catch (err) {
      this.softError('invoices.verify', err);
    }

    step(`invoices.getAuditTrail → GET /invoices/${invoiceId}/audit-trail`);
    try {
      await this.client.get(`/invoices/${invoiceId}/audit-trail`);
    } catch (err) {
      this.softError('invoices.getAuditTrail', err);
    }

    step(`invoices.generateAuditTrailPdf → POST /invoices/${invoiceId}/audit-trail/pdf`);
    try {
      await this.client.post(
        `/invoices/${invoiceId}/audit-trail/pdf`,
        undefined,
        this.idem('audit-pdf', invoiceId),
      );
    } catch (err) {
      this.softError('invoices.generateAuditTrailPdf', err);
    }

    // D.15 — Clone (manual one-off recurrence).
    step(`invoices.clone → POST /invoices/${invoiceId}/clone`);
    try {
      const clone = await this.client.post<Invoice>(`/invoices/${invoiceId}/clone`);
      detail(`clone créé: ${clone.id}`);
    } catch (err) {
      this.softError('invoices.clone', err);
    }
  }

  // ===========================================================================
  // E. Abonnement récurrent (cœur SaaS)
  // ===========================================================================
  async phaseE(ctx: ScenarioContext): Promise<void> {
    phase('E', 'Abonnement récurrent');
    const customerId = this.requireCustomer(ctx);

    step('recurringInvoices.create → POST /recurring-invoices (mensuel)');
    try {
      const recurring = await this.client.post<RecurringInvoice>(
        '/recurring-invoices',
        {
          customerId,
          frequency: 'monthly',
          startDate: this.today(),
          nextGenerationDate: this.addDays(30),
          autoFinalize: true,
          autoSend: false,
          // The template is a regular invoice payload minus the dates the
          // engine fills in per occurrence.
          templateInvoice: this.sampleSubscriptionTemplate(ctx),
        },
        this.idem('recurring', customerId),
      );
      ctx.recurringId = recurring.id;
      detail(`abonnement=${recurring.id} status=${recurring.status}`);
    } catch (err) {
      this.softError('recurringInvoices.create', err);
    }

    step('recurringInvoices.list → GET /recurring-invoices');
    try {
      const list = await this.client.listAll<RecurringInvoice>('/recurring-invoices');
      detail(`${list.length} abonnement(s)`);
    } catch (err) {
      this.softError('recurringInvoices.list', err);
    }

    if (ctx.recurringId) {
      const id = ctx.recurringId;
      step(`recurringInvoices.get → GET /recurring-invoices/${id}`);
      await this.client.get(`/recurring-invoices/${id}`).catch((e) => this.softError('get', e));

      step(`recurringInvoices.update → PATCH /recurring-invoices/${id}`);
      await this.client
        .patch(`/recurring-invoices/${id}`, { autoSend: true })
        .catch((e) => this.softError('update', e));

      step(`recurringInvoices.pause → POST /recurring-invoices/${id}/pause`);
      await this.client.post(`/recurring-invoices/${id}/pause`).catch((e) => this.softError('pause', e));

      step(`recurringInvoices.resume → POST /recurring-invoices/${id}/resume`);
      await this.client
        .post(`/recurring-invoices/${id}/resume`)
        .catch((e) => this.softError('resume', e));
    }
  }

  // ===========================================================================
  // F. Avoir (credit note)
  // ===========================================================================
  async phaseF(ctx: ScenarioContext): Promise<void> {
    phase('F', 'Avoir');
    const customerId = this.requireCustomer(ctx);
    if (!ctx.invoiceId) {
      warn('aucune facture en contexte — phase F ignorée');
      return;
    }

    step('creditNotes.create → POST /credit-notes (lié à la facture)');
    try {
      const creditNote = await this.client.post<CreditNote>(
        '/credit-notes',
        {
          customerId,
          relatedInvoiceId: ctx.invoiceId,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Geste commercial — 1 heure offerte',
          items: [
            {
              description: 'Remboursement 1h de conseil',
              quantity: '1',
              unitPrice: 13000, // 130,00 €
              vatRate: 2000,
              vatCode: 'S',
              unit: 'hour',
            },
          ],
          dates: { issued: this.today() },
        },
        this.idem('credit-note', ctx.invoiceId),
      );
      ctx.creditNoteId = creditNote.id;
      detail(`avoir=${creditNote.id} status=${creditNote.status}`);
    } catch (err) {
      this.softError('creditNotes.create', err);
    }

    if (ctx.creditNoteId) {
      const id = ctx.creditNoteId;
      step(`creditNotes.finalize → POST /credit-notes/${id}/finalize`);
      await this.client
        .post(`/credit-notes/${id}/finalize`, undefined, this.idem('cn.finalize', id))
        .catch((e) => this.softError('creditNotes.finalize', e));

      step(`creditNotes.send → POST /credit-notes/${id}/send`);
      await this.client.post(`/credit-notes/${id}/send`).catch((e) => this.softError('creditNotes.send', e));

      step(`creditNotes.getPdf → GET /credit-notes/${id}/pdf`);
      await this.client.get(`/credit-notes/${id}/pdf`).catch((e) => this.softError('creditNotes.getPdf', e));

      step(`creditNotes.getFacturx → GET /credit-notes/${id}/facturx`);
      await this.client
        .get(`/credit-notes/${id}/facturx`)
        .catch((e) => this.softError('creditNotes.getFacturx', e));

      // invoices.get avec expand=credit_notes: récupère les avoirs liés et le
      // solde net de la facture (TTC − avoirs) en un seul appel.
      step(`invoices.get (expand) → GET /invoices/${ctx.invoiceId}?expand=credit_notes`);
      try {
        const invoice = await this.client.get<Invoice>(`/invoices/${ctx.invoiceId}`, {
          expand: 'credit_notes',
        });
        const linked = invoice.expanded?.credit_notes ?? [];
        detail(
          `${linked.length} avoir(s) lié(s) · solde net = ${invoice.expanded?.net_balance ?? '?'} €`,
        );
      } catch (err) {
        this.softError('invoices.get (expand=credit_notes)', err);
      }
    }
  }

  // ===========================================================================
  // G. Achats (factures reçues)
  // ===========================================================================
  async phaseG(ctx: ScenarioContext): Promise<void> {
    phase('G', 'Achats (factures reçues)');

    step('invoices.createIncoming → POST /invoices/incoming');
    try {
      const incoming = await this.client.post<Identified>(
        '/invoices/incoming',
        {
          senderName: 'Fournitures Pro SAS',
          senderSiret: '55208131766522',
          amount: 24000, // 240,00 € TTC en centimes
          reference: 'FP-2026-3310',
          notes: 'Consommables atelier',
        },
        this.idem('incoming', 'FP-2026-3310'),
      );
      // Drive the lifecycle (approve / record payment) on this fresh invoice.
      if (incoming.id) ctx.receivedInvoiceId = incoming.id;
      detail(`facture entrante enregistrée: ${incoming.id ?? '(sans id)'}`);
    } catch (err) {
      this.softError('invoices.createIncoming', err);
    }

    step('invoices.listIncoming → GET /invoices/incoming');
    try {
      const incoming = await this.client.list<Identified>('/invoices/incoming');
      detail(`${incoming.data.length} facture(s) entrante(s)`);
    } catch (err) {
      this.softError('invoices.listIncoming', err);
    }

    step('receivedInvoices.list → GET /received-invoices');
    try {
      const received = await this.client.list<Identified & { status?: string }>('/received-invoices');
      // Prefer the invoice we just created above; fall back to the first listed.
      const firstReceived = received.data[0]?.id;
      if (!ctx.receivedInvoiceId && firstReceived) ctx.receivedInvoiceId = firstReceived;
      detail(`${received.data.length} facture(s) reçue(s)`);
    } catch (err) {
      this.softError('receivedInvoices.list', err);
    }

    if (ctx.receivedInvoiceId) {
      const id = ctx.receivedInvoiceId;
      step(`receivedInvoices.get → GET /received-invoices/${id}`);
      await this.client.get(`/received-invoices/${id}`).catch((e) => this.softError('get', e));

      step(`receivedInvoices.approve → POST /received-invoices/${id}/approve`);
      await this.client
        .post(`/received-invoices/${id}/approve`)
        .catch((e) => this.softError('approve', e));

      // approve / refuse / suspend are mutually exclusive lifecycle moves; we
      // demo approve, then record the supplier payment. refuse/suspend below
      // are shown but guarded so we don't fight the state machine on a re-run.
      if (ALLOW_DESTRUCTIVE) {
        step(`receivedInvoices.suspend → POST /received-invoices/${id}/suspend`);
        await this.client
          .post(`/received-invoices/${id}/suspend`)
          .catch((e) => this.softError('suspend', e));
        step(`receivedInvoices.refuse → POST /received-invoices/${id}/refuse`);
        await this.client.post(`/received-invoices/${id}/refuse`).catch((e) => this.softError('refuse', e));
      } else {
        warn('receivedInvoices.suspend/refuse codés mais ignorés (ALLOW_DESTRUCTIVE=1 pour activer)');
      }

      step(`receivedInvoices.recordPayment → POST /received-invoices/${id}/record-payment`);
      await this.client
        .post(
          `/received-invoices/${id}/record-payment`,
          { amount: 24000, method: 'transfer', paidAt: new Date().toISOString().slice(0, 10) },
          this.idem('recv.pay', id),
        )
        .catch((e) => this.softError('recordPayment', e));
    }
  }

  // ===========================================================================
  // H. Webhooks
  // ===========================================================================
  async phaseH(ctx: ScenarioContext): Promise<void> {
    phase('H', 'Webhooks');

    // H.19 — Register this server's public /webhooks URL (lookup-or-create).
    const targetUrl = `${this.config.publicBaseUrl || 'https://example.com'}/webhooks`;

    step('webhookEndpoints.list → GET /webhook-endpoints (lookup-or-create)');
    let endpointId: string | undefined;
    try {
      const endpoints = await this.client.listAll<WebhookEndpoint>('/webhook-endpoints');
      endpointId = endpoints.find((e) => e.url === targetUrl)?.id;
    } catch (err) {
      this.softError('webhookEndpoints.list', err);
    }

    if (!endpointId) {
      step('webhookEndpoints.create → POST /webhook-endpoints');
      try {
        const created = await this.client.post<WebhookEndpoint>(
          '/webhook-endpoints',
          {
            url: targetUrl,
            events: [
              'invoice.finalized',
              'invoice.transmitted',
              'invoice.paid',
              'quote.accepted',
              'credit_note.finalized',
            ],
            description: 'Atelier Dupont — no-SDK demo server',
          },
          this.idem('webhook-endpoint', targetUrl),
        );
        endpointId = created.id;
        // The signing secret (whsec_…) is shown ONCE, here. Put it in
        // FACTURINO_WEBHOOK_SECRET so /webhooks can verify deliveries.
        detail(`endpoint=${created.id} secret=${created.secret ? created.secret.slice(0, 12) + '…' : '(set FACTURINO_WEBHOOK_SECRET)'}`);
      } catch (err) {
        this.softError('webhookEndpoints.create', err);
      }
    } else {
      detail(`endpoint existant réutilisé: ${endpointId}`);
    }
    if (endpointId) ctx.webhookEndpointId = endpointId;

    if (endpointId) {
      step(`webhookEndpoints.test → POST /webhook-endpoints/${endpointId}/test`);
      try {
        await this.client.post(`/webhook-endpoints/${endpointId}/test`);
        detail('ping de test envoyé — voir les logs /webhooks');
      } catch (err) {
        this.softError('webhookEndpoints.test', err);
      }
    }

    // H.21 — Replay: events list / get / retry.
    step('events.list → GET /events');
    let firstEventId: string | undefined;
    try {
      const events = await this.client.list<Identified & { type?: string }>('/events', {
        limit: 10,
      });
      firstEventId = events.data[0]?.id;
      detail(`${events.data.length} évènement(s) récents`);
    } catch (err) {
      this.softError('events.list', err);
    }

    if (firstEventId) {
      step(`events.get → GET /events/${firstEventId}`);
      await this.client.get(`/events/${firstEventId}`).catch((e) => this.softError('events.get', e));

      step(`events.retry → POST /events/${firstEventId}/retry`);
      await this.client
        .post(`/events/${firstEventId}/retry`)
        .catch((e) => this.softError('events.retry', e));
    }
  }

  // ===========================================================================
  // I. Comptabilité & pilotage
  // ===========================================================================
  async phaseI(ctx: ScenarioContext): Promise<void> {
    phase('I', 'Comptabilité & pilotage');
    void ctx;

    const periodStart = `${new Date().getFullYear()}-01-01`;
    const periodEnd = `${new Date().getFullYear()}-12-31`;
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM

    // I.22 — Reporting.
    step('reporting.vatReport → GET /reporting/vat');
    await this.client
      .get('/reporting/vat', { period_start: periodStart, period_end: periodEnd })
      .catch((e) => this.softError('reporting.vatReport', e));

    step('reporting.revenueReport → GET /reporting/revenue');
    await this.client
      .get('/reporting/revenue', { period_start: periodStart, period_end: periodEnd })
      .catch((e) => this.softError('reporting.revenueReport', e));

    // I.23 — Exports (async → poll status).
    step('exports.generateFec → POST /exports/fec (+ getFecStatus)');
    try {
      const fec = await this.client.post<Job>(
        '/exports/fec',
        { period_start: periodStart, period_end: periodEnd },
        this.idem('fec', periodStart, periodEnd),
      );
      detail(`FEC job=${fec.id} status=${fec.status}`);
      if (fec.id) {
        const status = await this.client.get<Job>(`/exports/fec/${fec.id}`);
        detail(`FEC status=${status.status}`);
      }
    } catch (err) {
      this.softError('exports.generateFec', err);
    }

    step('exports.exportInvoices → POST /exports/invoices (+ getExportStatus)');
    try {
      const job = await this.client.post<Job>(
        '/exports/invoices',
        { period_start: periodStart, period_end: periodEnd, statuses: ['paid', 'partially_paid'] },
        this.idem('export-invoices', periodStart),
      );
      if (job.id) {
        await this.client.get(`/exports/${job.id}`).catch((e) => this.softError('getExportStatus', e));
      }
    } catch (err) {
      this.softError('exports.exportInvoices', err);
    }
    // Account-level RGPD data portability (GDPR art. 20) is covered by
    // account.requestExport / downloadExport in phase J.

    // I.24 — E-reporting (B2C / intra-EU declaration).
    step('ereporting.createDeclaration → POST /ereporting/declarations');
    let declarationId: string | undefined;
    try {
      const declaration = await this.client.post<Identified>(
        '/ereporting/declarations',
        {
          type: 'b2c',
          period,
          lines: [{ category: 'standard', amount: 100000, vatRate: 2000, vatAmount: 20000 }],
        },
        this.idem('ereporting', period),
      );
      declarationId = declaration.id;
      detail(`déclaration=${declaration.id}`);
    } catch (err) {
      this.softError('ereporting.createDeclaration', err);
    }

    step('ereporting.list → GET /ereporting/declarations');
    await this.client.list('/ereporting/declarations').catch((e) => this.softError('ereporting.list', e));

    if (declarationId) {
      step(`ereporting.get → GET /ereporting/declarations/${declarationId}`);
      await this.client
        .get(`/ereporting/declarations/${declarationId}`)
        .catch((e) => this.softError('ereporting.get', e));

      step(`ereporting.submitDeclaration → POST /ereporting/declarations/${declarationId}/submit`);
      if (ALLOW_DESTRUCTIVE) {
        await this.client
          .post(`/ereporting/declarations/${declarationId}/submit`)
          .catch((e) => this.softError('ereporting.submit', e));
      } else {
        warn('ereporting.submit codé mais ignoré (transmet à la DGFiP — ALLOW_DESTRUCTIVE=1)');
      }
    }

    // I.25 — Archives.
    step('archives.list → GET /archives');
    let archiveInvoiceId: string | undefined;
    try {
      const archives = await this.client.list<{ invoiceId?: string }>('/archives');
      archiveInvoiceId = archives.data[0]?.invoiceId;
      detail(`${archives.data.length} archive(s)`);
    } catch (err) {
      this.softError('archives.list', err);
    }
    if (archiveInvoiceId) {
      step(`archives.get → GET /archives/${archiveInvoiceId}`);
      await this.client.get(`/archives/${archiveInvoiceId}`).catch((e) => this.softError('archives.get', e));
    }
  }

  // ===========================================================================
  // J. Administration du compte
  // ===========================================================================
  async phaseJ(): Promise<void> {
    phase('J', 'Administration du compte');

    // J.29 — Facturino's own billing (the subscription that powers this SaaS).
    step('billing.retrieveSubscription → GET /billing/subscription');
    await this.client.get('/billing/subscription').catch((e) => this.softError('billing.subscription', e));

    step('billing.listInvoices → GET /billing/invoices');
    let platformInvoiceId: string | undefined;
    try {
      const invoices = await this.client.list<Identified>('/billing/invoices');
      platformInvoiceId = invoices.data[0]?.id;
      detail(`${invoices.data.length} facture(s) Facturino`);
    } catch (err) {
      this.softError('billing.listInvoices', err);
    }
    if (platformInvoiceId) {
      step(`billing.getInvoicePdf → GET /billing/invoices/${platformInvoiceId}/pdf`);
      await this.client
        .get(`/billing/invoices/${platformInvoiceId}/pdf`)
        .catch((e) => this.softError('billing.getInvoicePdf', e));
    }

    // J.30 — RGPD: request a data export, then download it.
    step('account.requestExport → POST /account/export');
    try {
      const exportJob = await this.client.post<Job>(
        '/account/export',
        undefined,
        this.idem('account-export', this.today()),
      );
      detail(`export job=${exportJob.id} status=${exportJob.status}`);
      if (exportJob.id) {
        step(`account.downloadExport → GET /account/exports/${exportJob.id}/download`);
        await this.client
          .get(`/account/exports/${exportJob.id}/download`)
          .catch((e) => this.softError('account.downloadExport', e));
      }
    } catch (err) {
      this.softError('account.requestExport', err);
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Resolve the company id to operate on: env override, else the first one. */
  private async resolveCompanyId(): Promise<string> {
    const fromEnv = process.env['FACTURINO_COMPANY_ID'];
    if (fromEnv) return fromEnv;
    const companies = await this.client.list<Company>('/companies', { limit: 1 });
    const first = companies.data[0];
    if (!first) {
      throw new Error(
        'No company on this account. Create one in the Facturino dashboard, or set ' +
          'FACTURINO_COMPANY_ID.',
      );
    }
    return first.id;
  }

  private requireCustomer(ctx: ScenarioContext): string {
    if (!ctx.customerId) {
      throw new Error('No customer in context — phase B must run first.');
    }
    return ctx.customerId;
  }

  /**
   * GET a document endpoint that may return either the bytes directly OR a
   * `202 { job_id }` when generation is async. When async, poll `jobs.poll`.
   */
  private async fetchDocumentMaybeAsync(
    path: string,
    query?: Record<string, string>,
  ): Promise<void> {
    try {
      const res = await this.client.request<{ jobId?: string; job_id?: string; url?: string }>(
        'GET',
        path,
        query ? { query } : {},
      );
      const jobId = res?.jobId ?? res?.job_id;
      if (jobId) {
        detail(`génération asynchrone → jobs.poll(${jobId})`);
        await this.pollJob(jobId);
      } else {
        detail('document disponible');
      }
    } catch (err) {
      this.softError(`document ${path}`, err);
    }
  }

  /** Poll GET /jobs/:id until terminal, with a small bounded loop. */
  private async pollJob(jobId: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const job = await this.client.get<Job>(`/jobs/${jobId}`);
      if (job.status === 'completed' || job.status === 'succeeded') {
        detail(`job ${jobId} terminé`);
        return;
      }
      if (job.status === 'failed') {
        fail(`job ${jobId} échoué`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    warn(`job ${jobId} toujours en cours après le délai imparti`);
  }

  /** A complete, EN16931-shaped invoice payload (reused by create + validate). */
  private sampleInvoicePayload(customerId: string): unknown {
    return {
      type: 'standard',
      customerId,
      // BG-7 buyer block — SIRET (BT-46) + delivery address.
      buyer: {
        companyName: 'Café des Artisans SARL',
        siret: '55208131766522',
        vatNumber: 'FR40552081317',
        address: { line1: '12 rue des Lilas', postalCode: '75011', city: 'Paris', country: 'FR' },
        deliveryAddress: {
          line1: '12 rue des Lilas',
          postalCode: '75011',
          city: 'Paris',
          country: 'FR',
        },
      },
      lines: [
        {
          description: 'Prestation de conseil',
          quantity: '8',
          unitPrice: 13000, // 130,00 €/h
          vatRate: 2000, // 20,00 %
          vatCode: 'S',
          unit: 'hour',
        },
        {
          description: 'Abonnement plateforme (1 mois)',
          quantity: '1',
          unitPrice: 4900, // 49,00 €
          vatRate: 2000,
          vatCode: 'S',
          unit: 'month',
          discountPercent: 1000, // 10,00 % de remise
        },
      ],
      dates: { issued: this.today(), due: this.addDays(30) },
      payment: {
        terms: 'Paiement à 30 jours par virement',
        termsDays: 30,
        method: 'transfer',
        iban: 'FR7630006000011234567890189',
        bic: 'AGRIFRPP',
        latePaymentRate: '3 fois le taux légal',
        collectionFee: '40 €',
      },
      purchaseOrderNumber: 'PO-2026-0042', // BT-13
      notes: 'Merci pour votre confiance.',
    };
  }

  /** A subscription template invoice for the recurring engine (no dates). */
  private sampleSubscriptionTemplate(ctx: ScenarioContext): unknown {
    // templateInvoice carries the line items the recurring engine repeats each
    // period; the customer, dates and numbering are resolved per occurrence.
    return {
      items: [
        {
          description: 'Abonnement Atelier — mensuel',
          quantity: '1',
          unitPrice: 4900,
          vatRate: 2000,
          vatCode: 'S',
          unit: 'month',
          ...(ctx.subscriptionProductId ? { product: ctx.subscriptionProductId } : {}),
        },
      ],
      paymentMethod: 'sepa',
      paymentTermsDays: 0,
      notes: 'Abonnement mensuel — prélèvement SEPA.',
    };
  }

  /** Today as YYYY-MM-DD (UTC). */
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Today + n days as YYYY-MM-DD (UTC). */
  private addDays(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Log a non-fatal error and keep going. The scenario touches dozens of
   * endpoints; a plan-gated or state-machine-conflicting call shouldn't abort
   * the whole walkthrough. Always surfaces `request_id` for support.
   */
  private softError(operation: string, err: unknown): void {
    if (err instanceof FacturinoError) {
      fail(`${operation}: ${err.toString()}`);
    } else {
      fail(`${operation}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
