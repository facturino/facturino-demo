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
/** One line of a commercial draft: the operation as stated, with NO VAT. */
interface CommercialDraftLine {
  /** Assigned server-side at conversion; the decision reuses it. */
  reference: string;
  description: string;
  quantity: string;
  unit: string;
  /** Prix unitaire en centimes entiers, dans le `priceMode` du brouillon. */
  unitPrice: number;
  supplyCategory: string;
  rateCategory: string;
  discount?: { type: string; value: number };
  product?: string | null;
}
/** The operation an undecided draft states. A COMMERCIAL total: neither a decided net nor a decided gross amount. */
interface CommercialDraft {
  priceMode: string;
  lines: CommercialDraftLine[];
  totalCents: number;
}
interface Invoice extends Identified {
  status?: string;
  number?: string | null;
  dates?: { issued?: string; due?: string };
  totals?: { totalTTC?: string; amountDue?: string; amountPaid?: string };
  /**
   * The operation a COMMERCIAL draft states, before any decision. Present while
   * `taxSource` is `null`; it disappears once the invoice is bound to a decision.
   */
  commercialDraft?: CommercialDraft | null;
  // Three independent axes; `status` stays their historical projection.
  documentStatus?: string;
  transmissionStatus?: string;
  transmissionDetail?: string | null;
  paymentStatus?: string;
  // Fiscal authority of the document.
  taxSource?: string;
  taxDecisionId?: string;
  // Present only when ?expand=credit_notes is requested.
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

/**
 * Immutable fiscal position. Only a `final` decision carries amounts: on any
 * other status, `totals` and `amountToCharge` are `null`, never `0`.
 */
interface TaxDecision extends Identified {
  status: 'final' | 'pending_verification' | 'unsupported';
  /** Fiscal source of the decision: `facturino` or `integration`. */
  taxSource?: string;
  customerId: string;
  currency: string;
  priceMode: 'tax_exclusive' | 'tax_inclusive';
  effectiveAt: string;
  expiresAt?: string;
  expired?: boolean;
  rulesVersion?: string;
  operationFingerprint?: string;
  totals: { totalHT: number; totalVAT: number; totalTTC: number } | null;
  amountToCharge: number | null;
  invoiceChannel: 'einvoicing' | 'none' | null;
  transactionReporting: 'ereporting' | 'none' | 'outside_scope' | null;
  paymentReporting: 'fr212' | 'ereporting' | 'none' | null;
  /**
   * The axes French law settles even when the decision is NOT final. `null` on
   * a final decision, where the three axes above are the settled ones. It
   * authorises nothing: a non-final decision is not invoiceable.
   */
  settledObligations?: {
    invoiceChannel: 'einvoicing' | 'none' | null;
    transactionReporting: 'ereporting' | 'none' | 'outside_scope' | null;
    paymentReporting: 'fr212' | 'ereporting' | 'none' | null;
  } | null;
  /**
   * What the EU B2C destination rule concluded, frozen as data: the verdict and
   * its basis, the threshold figures, the declarative mechanism and the rate
   * entry with its registry version, its source, its verification date and its
   * period. `null` on every operation the rule does not reach — this workshop
   * invoices French customers, so it stays `null` throughout the scenario.
   */
  euB2cDestination?: {
    place: 'origin' | 'destination' | null;
    /**
     * What settled the place. `oss_union_registration`: the seller holds an
     * ACTIVE Union one-stop-shop registration — for a French seller, registering
     * IS how the option of art. 59c(3) is exercised, so the threshold has
     * nothing left to decide and `threshold` stays `null`.
     */
    basis: string | null;
    /**
     * How the destination tax is declared — and the DATED registration that
     * serves this operation. A one-stop shop opened in October does not declare
     * a September sale.
     */
    mechanism: {
      kind: string;
      memberState: string;
      reference: string;
      memberStateOfIdentification: string | null;
      effectiveFrom: string;
      effectiveTo: string | null;
    } | null;
    rate: { registryVersion: string; centipercent: number; regionId: string | null } | null;
    /**
     * How the single-evidence relaxation of art. 24b was settled, with the
     * figures it rested on. It is COMPUTED on the ledger's own EUR 100,000
     * counter — never the EUR 10,000 one, which also counts distance sales of
     * goods — and never declared by the seller.
     */
    evidenceRelief: {
      status: 'available' | 'unavailable' | 'undeterminable';
      capCents: number;
      previousYearAmountCents: number | null;
      cumulativeAfterMinCents: number | null;
      cumulativeAfterMaxCents: number | null;
      undeterminedCode: string | null;
    } | null;
    /**
     * The slice of the ANNUAL LEDGER the decision took: which ledger, at which
     * version, at which position in its total order, and the totals before and
     * after. The running total is not a field of the fiscal profile.
     */
    threshold: {
      stateId: string;
      year: string;
      stateVersion: number;
      sequence: number;
      coverageMode: 'facturino_only' | 'mixed_channels';
      /**
       * What CERTAINLY precedes the operation (settled movements only) and what
       * may (the same total plus every slice held by an operation being decided
       * at the same moment). A verdict is frozen only when it holds at both, so
       * an abandoned operation never has to be kept in the total to protect it.
       */
      cumulativeBeforeMinCents: number;
      cumulativeBeforeMaxCents: number;
      pendingPredecessorCount: number;
      operationValueMinCents: number;
      cumulativeAfterMinCents: number;
    } | null;
  } | null;
  foreignTaxReviewRequired?: boolean;
  vies?: { status?: string } | null;
  issues?: Array<{ code: string; message: string }>;
  obligationReasons?: Array<{ axis: string; code: string; reference: string; message?: string }>;
  retryOfTaxDecisionId?: string | null;
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
  taxDecisionId?: string;
  decidedInvoiceId?: string;
  depositInvoiceId?: string;
  mainDecisionId?: string;
  /**
   * Le brouillon COMMERCIAL produit par la conversion du devis, son bloc
   * commercial block and its issue date: phase D decides that operation and
   * binds the decision to THAT document.
   */
  convertedInvoiceId?: string;
  convertedDraft?: CommercialDraft;
  convertedIssuedOn?: string | null;
}

export class Scenario {
  private readonly client: FacturinoClient;
  private readonly config: Config;
  /** Fresh per run() so re-running never collides on a stale Idempotency-Key. */
  private runId = '';
  /** Mandatory fiscal-journey steps that failed during the current run. */
  private fiscalFailures: string[] = [];

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

  /** Run the whole A→K workflow. Returns the resulting context. */
  async runAll(): Promise<ScenarioContext> {
    resetSteps();
    this.runId = randomUUID().slice(0, 8);
    this.fiscalFailures = [];
    const companyId = await this.resolveCompanyId();
    const ctx: ScenarioContext = { companyId };

    await this.phaseA(ctx);
    await this.phaseB(ctx);
    await this.phaseC(ctx);
    await this.phaseD(ctx);
    await this.phaseE(ctx);
    await this.phaseK(ctx);
    await this.phaseF(ctx);
    await this.phaseG(ctx);
    await this.phaseH(ctx);
    await this.phaseI(ctx);
    await this.phaseJ();

    if (this.fiscalFailures.length > 0) {
      // The fiscal journey is the point of the walkthrough: a failed mandatory
      // step means the scenario did NOT complete, whatever else succeeded.
      console.log(
        `\n\x1b[1m\x1b[38;5;196m✗ Scenario failed — ${this.fiscalFailures.length} mandatory fiscal step(s): ` +
          `${this.fiscalFailures.join(', ')}\x1b[0m`,
      );
      throw new Error(`fiscal journey failed at: ${this.fiscalFailures.join(', ')}`);
    }

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
      step('companies.getCgv → GET /companies/:id/cgv (signed URL)');
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
        vatRate: 2000, // 20.00%, in hundredths of a percent
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

    // products.list with filters: q (name prefix search), category,
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
      detail(`SIRENE: ${lookup.found ? (lookup.data?.name ?? 'found') : 'no result'}`);
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
      detail(`reused existing customer: ${found.id}`);
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
          // Billing contact: receives invoices by default (billing role).
          contacts: [{ email: 'compta@cafe-des-artisans.example', role: 'billing' }],
          paymentTerms: 30,
        },
        this.idem('customer', '55208131766522'),
      );
      ctx.customerId = customer.id;
      detail(`customer created: ${customer.id}`);
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
      detail('quote accepted');
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
    // the accepted original). Idempotent per source quote so it stays replayable.
    step(`quotes.clone → POST /quotes/${quote.id}/clone (re-proposition en brouillon)`);
    try {
      const cloned = await this.client.post<Quote>(
        `/quotes/${quote.id}/clone`,
        undefined,
        this.idem('quote.clone', quote.id),
      );
      detail(`quote cloned (draft): ${cloned.id} status=${cloned.status}`);
    } catch (err) {
      this.softError('quotes.clone', err);
    }

    step(`quotes.convert → POST /quotes/${quote.id}/convert (→ brouillon commercial)`);
    // Pas de softError ici : sans brouillon converti, le cycle devis de la
    // phase D has nothing left to run. A failure must stop the scenario, never
    // be dressed up as a success.
    const converted = await this.client.post<Invoice>(`/quotes/${quote.id}/convert`);
    if (!converted.commercialDraft || converted.commercialDraft.lines.length === 0) {
      throw new Error(`quotes.convert returned a draft with no commercial operation (${converted.id})`);
    }
    // Conversion produces a COMMERCIAL DRAFT: the quote's VAT was indicative, so
    // the draft awaits its own decision (taxSource: null). Phase D decides THAT
    // operation, binds the decision to THAT document, then
    // finalise — jamais une seconde facture.
    ctx.convertedInvoiceId = converted.id;
    ctx.convertedDraft = converted.commercialDraft;
    ctx.convertedIssuedOn = converted.dates?.issued ?? null;
    detail(`commercial draft from the quote: ${converted.id} (not decided yet)`);

    // C.8 — validate.run: EN16931 dry-run. Even the dry-run is decision-first:
    // the decision is taken first; the validation persists nothing and does not
    // consume the decision — phase D reuses it.
    step('taxDecisions.create + validate.run → POST /validate (nothing issued)');
    try {
      const decision = await this.decideMainOperation(ctx, customerId);
      if (decision !== null) {
        const validation = await this.client.post<{ valid?: boolean; errors?: unknown[] }>(
          '/validate',
          this.invoicePayloadFromDecision(customerId, decision.id),
        );
        detail(`valid=${validation.valid ?? '?'} errors=${validation.errors?.length ?? 0}`);
      }
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

    // D.9 — La facture est celle que le DEVIS a produite. Son bloc commercial
    // block is read back from the conversion: the line references are assigned
    // server-side, and the decision must state exactly the operation the draft
    // carries. The decision is then BOUND to that same document — creating a
    // second one would leave the converted draft orphaned.
    const convertedId = ctx.convertedInvoiceId;
    const draft = ctx.convertedDraft;
    const issuedOn = ctx.convertedIssuedOn;
    if (!convertedId || !draft || !issuedOn) {
      throw new Error('aucun brouillon converti : le cycle devis ne peut pas se poursuivre');
    }

    step('taxDecisions.create → POST /tax-decisions (operation of the converted draft)');
    const decision = await this.decideConvertedDraft(customerId, draft, issuedOn);
    if (decision === null) {
      throw new Error(`the operation of draft ${convertedId} is not decidable — no invoice is issued`);
    }
    ctx.mainDecisionId = decision.id;

    step(`invoices.bindTaxDecision → POST /invoices/${convertedId}/bind-tax-decision`);
    const invoice = await this.client.post<Invoice>(
      `/invoices/${convertedId}/bind-tax-decision`,
      {
        taxDecisionId: decision.id,
        decisionLines: draft.lines.map((line) => ({
          taxLineRef: line.reference,
          unit: line.unit,
          ...(line.product ? { product: line.product } : {}),
        })),
      },
      this.idem('bind-decision', convertedId),
    );
    ctx.invoiceId = invoice.id;
    detail(`invoice=${invoice.id} status=${invoice.status} taxSource=${invoice.taxSource}`);
    const invoiceId = ctx.invoiceId;

    step(`invoices.finalize → POST /invoices/${invoiceId}/finalize (numbering)`);
    try {
      const finalized = await this.client.post<Invoice>(
        `/invoices/${invoiceId}/finalize`,
        undefined,
        // Idempotent finalize: a retried call returns the same number.
        this.idem('finalize', invoiceId),
      );
      ctx.invoiceNumber = finalized.number ?? null;
      detail(`number assigned: ${finalized.number ?? '(async)'}`);
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
    step(`invoices.send → POST /invoices/${invoiceId}/send (deposit to the PA)`);
    try {
      await this.client.post(
        `/invoices/${invoiceId}/send`,
        undefined,
        this.idem('invoice.send', invoiceId),
      );
      detail('deposited to the PA');
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
    detail('PA status simulated → approved');

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
      detail(`payment link: ${link.url ?? '(created)'}`);
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
      detail('partial payment recorded');
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
      detail(`${events.data.length} event(s) on the invoice`);
    } catch (err) {
      this.softError('invoices.listEvents', err);
    }

    // D.14 — Audit trail (hash chain + PDF).
    step(`invoices.verify → GET /invoices/${invoiceId}/verify (hash chain)`);
    try {
      const verify = await this.client.get<{ verified?: boolean }>(`/invoices/${invoiceId}/verify`);
      detail(`hash chain valid=${verify.verified ?? '?'}`);
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
      detail(`clone created: ${clone.id}`);
    } catch (err) {
      this.softError('invoices.clone', err);
    }
  }

  // ===========================================================================
  // E. Recurring subscription (SaaS core)
  // ===========================================================================
  async phaseE(ctx: ScenarioContext): Promise<void> {
    phase('E', 'Recurring subscription');
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
          // `taxInputs` carries the operation and its fiscal source; every
          // occurrence is decided on its own generation date.
          taxInputs: this.sampleSubscriptionTaxInputs(ctx),
          // Presentation and terms only — never a line.
          templateInvoice: {
            paymentMethod: 'sepa',
            paymentTermsDays: 0,
            notes: 'Abonnement mensuel — prélèvement SEPA.',
          },
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
  /**
   * K — decision-first billing, on the raw HTTP contract.
   *
   * This phase is the reference for the exact wire shape: the path, the JSON
   * body, the `Idempotency-Key` header and the fields read back. Everything an
   * SDK would hide is visible here.
   *
   * The order is the point. The VAT and the exact amount to debit come from
   * Facturino BEFORE anything is collected, and the decision id travels with
   * the settlement so what was received can be checked against what was decided.
   *
   * Facturino imposes no payment service provider and no payment method. The
   * flow below is provider-neutral: the decision id is carried in the payment
   * REFERENCE, which every settlement has — a transfer, a direct debit, a
   * cheque, cash, or a PSP capture. Two PSP variants are shown afterwards as
   * examples; both are simulated locally, and no PSP is ever contacted.
   */
  async phaseK(ctx: ScenarioContext): Promise<void> {
    phase('K', 'Decision-backed invoicing');
    const customerId = this.requireCustomer(ctx);

    // K.2 — Decide BEFORE any payment.
    //
    //   POST /v1/tax-decisions
    //   Authorization: Bearer fac_test_…
    //   Content-Type: application/json
    //   Idempotency-Key: <stable per order>
    step('taxDecisions.create → POST /tax-decisions');
    let decision: TaxDecision | undefined;
    try {
      decision = await this.client.post<TaxDecision>(
        '/tax-decisions',
        {
          // Facturino determines the VAT; `taxSource: "integration"` is the
          // other journey, shown in phaseKIntegration.
          taxSource: 'facturino',
          customerId,
          // Civil date: a timestamp is refused, because turning an instant into
          // a civil date is a timezone decision that belongs to the caller.
          effectiveAt: this.today(),
          currency: 'eur',
          priceMode: 'tax_exclusive',
          lines: [
            {
              reference: 'abo-pro',
              description: 'Abonnement plateforme (1 mois)',
              // An online subscription is an electronically supplied service:
              // it carries its own place-of-supply rules.
              category: 'electronically_supplied_services',
              rateCategory: 'standard',
              unitAmount: 4900, // integer cents
              quantity: '1', // decimal STRING, never a float
            },
          ],
        },
        this.idem('tax-decision', customerId),
      );
      ctx.taxDecisionId = decision.id;
      detail(`decision=${decision.id} status=${decision.status}`);
    } catch (err) {
      this.fiscalError('taxDecisions.create', err);
      return;
    }

    // K.3 — Stop unless the decision is final. `pending_verification` does not
    // mean "nothing to charge": the amounts are null, not 0. On this MANDATORY
    // journey a non-final decision is a blocking fiscal outcome — recorded so
    // the run can never end on "Scenario complete".
    if (decision.status !== 'final' || decision.amountToCharge === null) {
      for (const issue of decision.issues ?? []) detail(`issue: ${issue.code} — ${issue.message}`);
      detail(`decision status=${decision.status}: amounts are null (not zero) — nothing is charged and no invoice is issued`);
      this.fiscalBlocked('taxDecisions.create', `decision is "${decision.status}", not "final"`);
      return;
    }

    // K.4/K.5 — Collect exactly what was decided, and carry the decision id in
    // the settlement REFERENCE. Every settlement has one: a transfer wording, a
    // direct-debit mandate reference, a cheque number, a PSP charge id.
    const amountToCharge = decision.amountToCharge;
    const settlement = {
      amount: amountToCharge,
      currency: decision.currency,
      // transfer, card, check, cash, direct_debit, sepa, paypal or other
      method: 'transfer',
      // The REAL reference of the movement — a transfer wording, a mandate
      // reference, a cheque number, a PSP charge id. It is what reconciles the
      // ledger entry with the bank statement, so it is never replaced by the
      // decision id: the decision travels ALONGSIDE it, not instead of it.
      reference: 'VIR/2026/000871',
      taxDecisionId: decision.id,
      paidAt: this.today(),
    };
    step('settlement (simulated) -> real reference + decision id alongside');
    detail(
      `amount=${settlement.amount} cents ${settlement.currency} | ` +
        `method=${settlement.method} | reference=${settlement.reference} | ` +
        `decision=${settlement.taxDecisionId}`,
    );

    // K.5b — OPTIONAL, for a PSP-collected payment. Two examples, nothing more:
    // Facturino requires neither. Simulated locally — nothing is sent.
    detail(
      `optional PSP variants — stripe.metadata=${JSON.stringify({ facturino_tax_decision_id: decision.id })} | ` +
        `paypal.custom_id=${decision.id} value=${(amountToCharge / 100).toFixed(2)}`,
    );

    // K.6 — Once settled, read the decision back from the reference carried
    // with the payment.
    //
    //   GET /v1/tax-decisions/{id}
    step('taxDecisions.retrieve → GET /tax-decisions/{id}');
    let source: TaxDecision;
    try {
      source = await this.client.get<TaxDecision>(`/tax-decisions/${settlement.taxDecisionId}`);
    } catch (err) {
      this.fiscalError('taxDecisions.retrieve', err);
      return;
    }

    // K.7 — Verify amount, currency and buyer against the decision.
    if (settlement.amount !== source.amountToCharge) {
      this.fiscalError('verification', new Error('settled amount differs from the decision'));
      return;
    }
    if (settlement.currency !== source.currency) {
      this.fiscalError('verification', new Error('settled currency differs from the decision'));
      return;
    }
    if (customerId !== source.customerId) {
      this.fiscalError('verification', new Error('settled buyer differs from the decision'));
      return;
    }
    detail('settlement matches the decision: amount, currency and buyer');

    // K.8 — The invoice is backed by the decision. `lines` is refused here: the
    // VAT comes from the decision, and `decisionLines` carries presentation only.
    step('invoices.create → POST /invoices (taxDecisionId + decisionLines)');
    let invoiceId: string;
    try {
      const draft = await this.client.post<Invoice>(
        '/invoices',
        {
          customerId: source.customerId,
          taxDecisionId: source.id,
          decisionLines: [{ taxLineRef: 'abo-pro', unit: 'month' }],
          buyer: this.decisionBuyerBlock(),
          dates: { issued: this.today(), due: this.addDays(30) },
          payment: this.decisionPaymentTerms(),
        },
        this.idem('decided-invoice', source.id),
      );
      invoiceId = draft.id;
    } catch (err) {
      this.fiscalError('invoices.create (decision-backed)', err);
      return;
    }

    // K.9 — Finalize: the number is assigned and the content is fixed.
    step('invoices.finalize → POST /invoices/{id}/finalize');
    try {
      const finalized = await this.client.post<Invoice>(
        `/invoices/${invoiceId}/finalize`,
        undefined,
        this.idem('decided-invoice-finalize', invoiceId),
      );
      ctx.decidedInvoiceId = finalized.id;
      detail(
        `invoice=${finalized.number} taxSource=${finalized.taxSource} | ` +
          `axes document=${finalized.documentStatus ?? finalized.status} ` +
          `transmission=${finalized.transmissionStatus ?? 'not_applicable'} ` +
          `payment=${finalized.paymentStatus ?? 'unpaid'}`,
      );
    } catch (err) {
      this.fiscalError('invoices.finalize (decision-backed)', err);
      return;
    }

    // K.10 — Send to the platform ONLY on the channel the decision states.
    if (source.invoiceChannel === 'einvoicing') {
      step('invoices.send → POST /invoices/{id}/send');
      try {
        await this.client.post(
          `/invoices/${ctx.decidedInvoiceId}/send`,
          undefined,
          this.idem('decided-invoice-send', ctx.decidedInvoiceId ?? invoiceId),
        );
        detail('deposited on the platform (invoiceChannel = einvoicing)');
      } catch (err) {
        this.fiscalError('invoices.send (decision-backed)', err);
      }
    } else {
      // Not a failure: the operation is simply outside the e-invoicing channel.
      // Calling /send here would be refused, and rightly so.
      step('decided channel != einvoicing -> no platform deposit');
      detail(
        `invoiceChannel=${source.invoiceChannel ?? 'none'} — any applicable obligation is handled through e-reporting`,
      );
    }

    // K.11 — Record the REAL collection on the invoice, with its real date, its
    // real method and the reference that carries the decision id. The payment
    // axis moves; the transmission axis does not.
    step('payments.create → POST /invoices/{id}/payments');
    try {
      await this.client.post(
        `/invoices/${ctx.decidedInvoiceId ?? invoiceId}/payments`,
        {
          amount: settlement.amount,
          method: settlement.method,
          reference: settlement.reference,
          paidAt: settlement.paidAt,
        },
        this.idem('decided-invoice-payment', ctx.decidedInvoiceId ?? invoiceId),
      );
      detail(`payment recorded - reference=${settlement.reference}`);
    } catch (err) {
      this.fiscalError('payments.create (decision-backed)', err);
    }

    // K.12 — Keep the reporting axes: they are the obligations, and they hold
    // whether or not the invoice travelled the network.
    step('reporting axes carried by the decision');
    detail(
      `transaction=${source.transactionReporting ?? 'none'} | payment=${source.paymentReporting ?? 'none'}` +
        (source.foreignTaxReviewRequired ? ' | foreignTaxReviewRequired=true' : ''),
    );
    for (const reason of source.obligationReasons ?? []) {
      detail(`  ${reason.axis}: ${reason.code} (${reason.reference})`);
    }

    await this.decidedCreditNote(ctx);
    await this.decidedRecurring(customerId);
    await this.decidedDeposit(ctx, customerId);
    await this.integrationDecision(customerId);
  }

  /**
   * K.12 — Credit a DECIDED invoice through `creditedLines`.
   *
   * The rate, the category, the VATEX code and the
   * legal mention are inherited from the invoice's frozen snapshot.
   */
  private async decidedCreditNote(ctx: ScenarioContext): Promise<void> {
    if (!ctx.decidedInvoiceId) return;

    step('creditNotes.create → POST /credit-notes (creditedLines)');
    try {
      const creditNote = await this.client.post<CreditNote & { originalTaxDecisionId?: string }>(
        '/credit-notes',
        {
          relatedInvoiceId: ctx.decidedInvoiceId,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Partial credit note on a decision-backed invoice',
          // Either `quantity` or `amountTTC`, never both. Omitting both credits
          // the line's whole remaining balance.
          creditedLines: [{ taxLineRef: 'abo-pro', amountTTC: 1200 }],
          dates: { issued: this.today() },
        },
        this.idem('decided-credit-note', ctx.decidedInvoiceId),
      );
      detail(`credit note=${creditNote.id} inherited decision=${creditNote.originalTaxDecisionId ?? ctx.taxDecisionId}`);
    } catch (err) {
      this.fiscalError('creditNotes.create (creditedLines)', err);
    }
  }

  /**
   * K.13 — A recurrence on the decided journey.
   *
   * `taxInputs` carries the OPERATION, not a decision: a recurrence never
   * stores one, so each occurrence is decided on its own effective date.
   */
  private async decidedRecurring(customerId: string): Promise<void> {
    step('recurringInvoices.create → POST /recurring-invoices (taxInputs)');
    try {
      const recurring = await this.client.post<RecurringInvoice>(
        '/recurring-invoices',
        {
          customerId,
          frequency: 'monthly',
          startDate: this.today(),
          nextGenerationDate: this.addDays(30),
          taxInputs: {
            taxSource: 'facturino',
            priceMode: 'tax_exclusive',
            lines: [
              {
                reference: 'abo-pro',
                description: 'Abonnement plateforme (1 mois)',
                category: 'electronically_supplied_services',
                rateCategory: 'standard',
                unitAmount: 4900,
                quantity: '1',
                unit: 'month',
              },
            ],
          },
          // `templateInvoice` carries the presentation and the terms —
          // jamais une ligne, jamais un taux.
          templateInvoice: { paymentMethod: 'transfer', paymentTermsDays: 30 },
        },
        this.idem('decided-recurring', customerId),
      );
      detail(`recurrence=${recurring.id} - every occurrence is decided on its own date`);
    } catch (err) {
      this.fiscalError('recurringInvoices.create (taxInputs)', err);
    }
  }

  /**
   * K.14 — The OTHER fiscal journey: the VAT is supplied by the integration.
   *
   * An ERP or an in-house rules engine that already determines the VAT declares
   * it on the decision (`taxSource: "integration"`). Facturino validates the
   * coherence of what is supplied and refuses any contradiction
   * (`integration_vat_incoherent`) — il ne corrige jamais un taux en silence.
   * The decision, the invoice and the reporting obligations work
   * ensuite exactement comme sur la source `facturino` : les deux parcours
   * are equal.
   */
  private async integrationDecision(customerId: string): Promise<void> {
    step('taxDecisions.create -> POST /tax-decisions (taxSource=integration)');
    let decision: TaxDecision;
    try {
      decision = await this.client.post<TaxDecision>(
        '/tax-decisions',
        {
          taxSource: 'integration',
          customerId,
          effectiveAt: this.today(),
          currency: 'eur',
          priceMode: 'tax_exclusive',
          lines: [
            {
              reference: 'conseil-integ',
              description: 'Prestation de conseil (TVA fournie par l\u2019ERP)',
              category: 'services',
              unitAmount: 10000,
              quantity: '1',
              vatRate: 2000, // 20.00% — concluded by YOUR system, never corrected
              vatCode: 'S',
            },
          ],
        },
        this.idem('integration-decision', customerId),
      );
    } catch (err) {
      this.fiscalError('taxDecisions.create (integration)', err);
      return;
    }
    if (decision.status !== 'final' || decision.amountToCharge === null) {
      this.fiscalBlocked('taxDecisions.create (integration)', `decision is "${decision.status}", not "final"`);
      return;
    }
    detail(`integration decision=${decision.id} amount=${decision.amountToCharge} taxSource=${decision.taxSource ?? 'integration'}`);

    // The invoice is created from the decision exactly as on the facturino
    // source — same contract, same axes, same obligation engine.
    step('invoices.create -> POST /invoices (from the integration decision)');
    try {
      const draft = await this.client.post<Invoice>(
        '/invoices',
        {
          customerId,
          buyer: this.decisionBuyerBlock(),
          taxDecisionId: decision.id,
          decisionLines: [{ taxLineRef: 'conseil-integ', unit: 'unit' }],
          dates: { issued: this.today(), due: this.addDays(30) },
          payment: this.decisionPaymentTerms(),
        },
        this.idem('integration-invoice', decision.id),
      );
      const invoice = await this.client.post<Invoice>(
        `/invoices/${draft.id}/finalize`,
        undefined,
        this.idem('integration-invoice-finalize', draft.id),
      );
      detail(`invoice=${invoice.number} taxSource=${invoice.taxSource}`);
    } catch (err) {
      this.fiscalError('invoices.create (integration)', err);
      return;
    }

    // A contradiction is refused, never corrected: a positive rate cannot carry
    // an exemption code.
    step('taxDecisions.create -> integration_vat_incoherent refusal (demonstration)');
    try {
      await this.client.post<TaxDecision>(
        '/tax-decisions',
        {
          taxSource: 'integration',
          customerId,
          effectiveAt: this.today(),
          currency: 'eur',
          priceMode: 'tax_exclusive',
          lines: [
            {
              reference: 'incoherent',
              description: 'Ligne incohérente (démonstration du refus)',
              category: 'services',
              unitAmount: 10000,
              quantity: '1',
              vatRate: 2000,
              vatCode: 'S',
              vatexCode: 'VATEX-EU-G',
            },
          ],
        },
        this.idem('integration-incoherent', customerId),
      );
      this.fiscalError('integration coherence', new Error('the contradiction was accepted; it must be refused'));
    } catch {
      detail('contradiction refused, never corrected (integration_vat_incoherent)');
    }
  }

  /**
   * K.11b — Deposit invoice (386), decided, invoiced and settled in full.
   *
   * The deposit is DECISION-BACKED, like everything else in this phase: it
   * describes its operation, receives a decision, and is then created with
   * `taxDecisionId` + `decisionLines`. A deposit states `category: "deposit"`
   * with the `relatedCategory` it is an advance on — that is what lets the
   * engine resolve its effective nature rather than guess it.
   *
   * The ORDER is the point: a deposit may only ever be deducted as PREPAID
   * (BT-113), and an amount is only prepaid once it has actually been
   * collected. The deposit is therefore decided, invoiced, and PAID IN FULL
   * here, and only then deducted from the balance invoice: `deposits` and
   * `schedule` settle SERVER-SIDE against the decided amount due.
   */
  private async decidedDeposit(ctx: ScenarioContext, customerId: string): Promise<void> {
    // --- the deposit -------------------------------------------------------
    step('taxDecisions.create -> POST /tax-decisions (deposit)');
    let depositDecision: TaxDecision;
    try {
      depositDecision = await this.client.post<TaxDecision>(
        '/tax-decisions',
        {
          taxSource: 'facturino',
          customerId,
          effectiveAt: this.today(),
          currency: 'eur',
          priceMode: 'tax_exclusive',
          lines: [
            {
              reference: 'deposit',
              description: 'Prestation d\u2019atelier \u2014 acompte',
              // An advance on a service: the engine resolves the effective
              // nature from `relatedCategory`, it does not infer it.
              category: 'deposit',
              relatedCategory: 'services',
              rateCategory: 'standard',
              unitAmount: 24000,
              quantity: '1',
            },
          ],
        },
        this.idem('deposit-decision', customerId),
      );
    } catch (err) {
      this.fiscalError('taxDecisions.create (deposit)', err);
      return;
    }
    if (depositDecision.status !== 'final' || depositDecision.amountToCharge === null) {
      for (const issue of depositDecision.issues ?? []) detail(`issue: ${issue.code} — ${issue.message}`);
      detail(`deposit decision status=${depositDecision.status}: amounts are null (not zero) — nothing is invoiced`);
      this.fiscalBlocked('taxDecisions.create (deposit)', `decision is "${depositDecision.status}", not "final"`);
      return;
    }
    detail(`deposit decision=${depositDecision.id} amount=${depositDecision.amountToCharge}`);

    step('invoices.create -> POST /invoices (type=deposit, taxDecisionId)');
    let depositId: string;
    try {
      const draft = await this.client.post<Invoice>(
        '/invoices',
        {
          type: 'deposit',
          customerId,
          buyer: this.decisionBuyerBlock(),
          taxDecisionId: depositDecision.id,
          // Presentation only: the VAT comes from the decision.
          decisionLines: [{ taxLineRef: 'deposit', unit: 'unit' }],
          dates: { issued: this.today(), due: this.addDays(30) },
          payment: this.decisionPaymentTerms(),
        },
        this.idem('deposit-draft', customerId),
      );
      const deposit = await this.client.post<Invoice>(
        `/invoices/${draft.id}/finalize`,
        undefined,
        this.idem('deposit-finalize', draft.id),
      );
      depositId = deposit.id;
      ctx.depositInvoiceId = deposit.id;
      detail(`deposit=${deposit.number} invoiced`);
    } catch (err) {
      this.fiscalError('invoices.create (deposit)', err);
      return;
    }

    // Record the payment IN FULL. Until this happens the deposit is not
    // prepaid, and must not be deducted from anything.
    step('payments.create -> POST /invoices/{deposit}/payments (settled in full)');
    try {
      await this.client.post(
        `/invoices/${depositId}/payments`,
        {
          amount: depositDecision.amountToCharge,
          method: 'transfer',
          // The real bank reference of the movement, not the decision id.
          reference: 'VIR/2026/000872',
          paidAt: this.today(),
        },
        this.idem('deposit-payment', depositId),
      );
      const settled = await this.client.get<Invoice>(`/invoices/${depositId}`);
      if ((settled.paymentStatus ?? settled.status) !== 'paid') {
        // Deducting an unsettled deposit anywhere would misstate BT-113.
        detail('deposit unpaid: it must not be deducted from any balance invoice');
        return;
      }
      detail('deposit settled - it may now be deducted as prepaid (BT-113)');
    } catch (err) {
      this.fiscalError('payments.create (deposit)', err);
      return;
    }

    // --- the balance invoice: deposit deducted + instalments ----------------
    //
    // `deposits` and `schedule` travel WITH the decision and settle
    // SERVER-SIDE against the decided amount: the settled deposit seeds
    // `amountPaid` (BT-113) and lowers `amountDue` (BT-115), and the
    // instalments must distribute exactly what remains due — the last one on
    // the invoice due date (BT-9).
    step('taxDecisions.create -> POST /tax-decisions (balance)');
    let balanceDecision: TaxDecision;
    try {
      balanceDecision = await this.client.post<TaxDecision>(
        '/tax-decisions',
        {
          taxSource: 'facturino',
          customerId,
          effectiveAt: this.today(),
          currency: 'eur',
          priceMode: 'tax_exclusive',
          lines: [
            {
              reference: 'prestation-atelier',
              description: 'Prestation d\u2019atelier',
              category: 'services',
              rateCategory: 'standard',
              unitAmount: 8000,
              quantity: '10',
            },
          ],
        },
        this.idem('balance-decision', customerId),
      );
    } catch (err) {
      this.fiscalError('taxDecisions.create (balance)', err);
      return;
    }
    if (balanceDecision.status !== 'final' || balanceDecision.amountToCharge === null) {
      this.fiscalBlocked('taxDecisions.create (balance)', `decision is "${balanceDecision.status}", not "final"`);
      return;
    }

    step('invoices.create -> POST /invoices (balance: deposits + schedule, settled server-side)');
    try {
      const stillDue = balanceDecision.amountToCharge - depositDecision.amountToCharge;
      const firstInstalment = Math.floor(stillDue / 2);
      const draft = await this.client.post<Invoice>(
        '/invoices',
        {
          customerId,
          buyer: this.decisionBuyerBlock(),
          taxDecisionId: balanceDecision.id,
          decisionLines: [{ taxLineRef: 'prestation-atelier', unit: 'hour' }],
          dates: { issued: this.today(), due: this.addDays(30) },
          payment: this.decisionPaymentTerms(),
          deposits: [{ invoiceId: depositId }],
          schedule: [
            { amount: firstInstalment, dueDate: this.addDays(15), label: 'Premier versement' },
            { amount: stillDue - firstInstalment, dueDate: this.addDays(30), label: 'Solde' },
          ],
        },
        this.idem('balance-draft', depositId),
      );
      const balance = await this.client.post<Invoice>(
        `/invoices/${draft.id}/finalize`,
        undefined,
        this.idem('balance-finalize', draft.id),
      );
      detail(
        `balance=${balance.number} | prepaid=${balance.totals?.amountPaid ?? '?'} | due=${balance.totals?.amountDue ?? '?'}`,
      );
    } catch (err) {
      this.fiscalError('invoices.create (balance)', err);
    }
  }

  /** Buyer block (BG-7) used by the decision-backed documents. */
  private decisionBuyerBlock(): unknown {
    return {
      companyName: 'Café des Artisans SARL',
      siret: '55208131766522',
      vatNumber: 'FR40552081317',
      address: { line1: '12 rue des Lilas', postalCode: '75011', city: 'Paris', country: 'FR' },
    };
  }

  /** Payment terms (BT-20) used by the decision-backed documents. */
  private decisionPaymentTerms(): unknown {
    return {
      terms: 'Paiement à 30 jours par virement',
      termsDays: 30,
      method: 'transfer',
      latePaymentRate: '3 fois le taux légal',
      collectionFee: '40 €',
    };
  }

  async phaseF(ctx: ScenarioContext): Promise<void> {
    phase('F', 'Avoir');
    if (!ctx.invoiceId) {
      warn('no invoice in context — phase F skipped');
      return;
    }

    step('creditNotes.create → POST /credit-notes (creditedLines)');
    try {
      // `creditedLines` references the DECIDED lines of the invoice: the rate,
      // the category, the VATEX code and the legal mention are inherited from
      // the frozen snapshot, never restated. `amountTTC` credits a fraction.
      const creditNote = await this.client.post<CreditNote>(
        '/credit-notes',
        {
          relatedInvoiceId: ctx.invoiceId,
          creditNoteType: 'partial',
          reasonCode: 'quality',
          reason: 'Geste commercial — 1 heure offerte',
          creditedLines: [
            { taxLineRef: 'conseil-heure', amountTTC: 15600 }, // 130,00 € HT + TVA
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

      // invoices.get with expand=credit_notes: fetches the linked credit notes and the
      // solde net de la facture (TTC − avoirs) en un seul appel.
      step(`invoices.get (expand) → GET /invoices/${ctx.invoiceId}?expand=credit_notes`);
      try {
        const invoice = await this.client.get<Invoice>(`/invoices/${ctx.invoiceId}`, {
          expand: 'credit_notes',
        });
        const linked = invoice.expanded?.credit_notes ?? [];
        detail(
          `${linked.length} linked credit note(s) · net balance = ${invoice.expanded?.net_balance ?? '?'} EUR`,
        );
      } catch (err) {
        this.softError('invoices.get (expand=credit_notes)', err);
      }
    }
  }

  // ===========================================================================
  // G. Purchases and received invoices
  // ===========================================================================
  async phaseG(ctx: ScenarioContext): Promise<void> {
    phase('G', 'Purchases and received invoices');

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
      detail(`incoming invoice recorded: ${incoming.id ?? '(no id)'}`);
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
      detail(`${received.data.length} received invoice(s)`);
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
        warn('receivedInvoices.suspend/refuse coded but skipped (set ALLOW_DESTRUCTIVE=1 to enable)');
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
      detail(`reused existing endpoint: ${endpointId}`);
    }
    if (endpointId) ctx.webhookEndpointId = endpointId;

    if (endpointId) {
      step(`webhookEndpoints.test → POST /webhook-endpoints/${endpointId}/test`);
      try {
        await this.client.post(`/webhook-endpoints/${endpointId}/test`);
        detail('test ping sent — see the /webhooks logs');
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
      detail(`${events.data.length} recent event(s)`);
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
  // I. Accounting and reporting
  // ===========================================================================
  async phaseI(ctx: ScenarioContext): Promise<void> {
    phase('I', 'Accounting and reporting');
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
      detail(`declaration=${declaration.id}`);
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
        warn('ereporting.submit coded but skipped (it transmits to the DGFiP — ALLOW_DESTRUCTIVE=1)');
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

    // J.30 — RGPD: request a data export, then poll the job. The download
    // URL surfaces on `GET /v1/exports/:jobId` (`download_url`) once the
    // worker has finished; `/account/exports/:id/download` serves the
    // `export_ready` notification link (`rgpdexp_…` id), not the job id.
    step('account.requestExport → POST /account/export');
    try {
      const exportJob = await this.client.post<Job>(
        '/account/export',
        undefined,
        this.idem('account-export', this.today()),
      );
      detail(`export job=${exportJob.id} status=${exportJob.status}`);
      if (exportJob.id) {
        step(`exports.getStatus → GET /exports/${exportJob.id} (poll RGPD)`);
        const status = await this.client
          .get<Job & { download_url?: string }>(`/exports/${exportJob.id}`)
          .catch((e) => this.softError('exports.getStatus', e));
        if (status) detail(`status=${status.status}${status.download_url ? ' — download URL ready' : ' (still processing)'}`);
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
        detail(`asynchronous generation → jobs.poll(${jobId})`);
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
        detail(`job ${jobId} finished`);
        return;
      }
      if (job.status === 'failed') {
        fail(`job ${jobId} failed`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    warn(`job ${jobId} still running after the allotted time`);
  }

  /**
   * Decides (source `facturino`) the main commercial operation: the lines
   * DESCRIBE the operation and never state a rate. A decision already taken
   * (C.8) is reused — the endpoint is idempotent and the
   * validation ne la consomme pas.
   */
  /**
   * Decides the operation a commercial draft states — same references, same
   * amounts, no VAT restated by the client. `effectiveAt` is the issue date OF
   * THE DRAFT: a decision dated elsewhere describes another operation and is
   * refused at binding.
   */
  private async decideConvertedDraft(
    customerId: string,
    draft: CommercialDraft,
    effectiveAt: string,
  ): Promise<TaxDecision | null> {
    const decision = await this.client.post<TaxDecision>(
      '/tax-decisions',
      {
        taxSource: 'facturino',
        customerId,
        effectiveAt,
        currency: 'eur',
        priceMode: draft.priceMode,
        lines: draft.lines.map((line) => ({
          reference: line.reference,
          description: line.description,
          category: line.supplyCategory,
          rateCategory: line.rateCategory,
          unitAmount: line.unitPrice,
          quantity: line.quantity,
          ...(line.discount ? { discount: line.discount } : {}),
        })),
      },
      this.idem('decision.converted-draft', customerId, effectiveAt),
    );
    if (decision.status !== 'final' || decision.amountToCharge === null) {
      for (const issue of decision.issues ?? []) warn(`manquant: ${issue.code} — ${issue.message}`);
      return null;
    }
    return decision;
  }

  private async decideMainOperation(
    ctx: ScenarioContext,
    customerId: string,
  ): Promise<TaxDecision | null> {
    if (ctx.mainDecisionId) {
      return this.client.get<TaxDecision>(`/tax-decisions/${ctx.mainDecisionId}`);
    }
    const decision = await this.client.post<TaxDecision>(
      '/tax-decisions',
      {
        taxSource: 'facturino',
        customerId,
        effectiveAt: this.today(),
        currency: 'eur',
        priceMode: 'tax_exclusive',
        lines: [
          {
            reference: 'conseil-heure',
            description: 'Prestation de conseil',
            category: 'services',
            rateCategory: 'standard',
            unitAmount: 13000, // 130,00 €/h
            quantity: '8',
          },
          {
            reference: 'abo-plateforme',
            description: 'Abonnement plateforme (1 mois)',
            category: 'electronically_supplied_services',
            rateCategory: 'standard',
            unitAmount: 4900, // 49,00 €
            quantity: '1',
            discount: { type: 'percent', value: 1000 }, // 10,00 % de remise
          },
        ],
      },
      this.idem('main-decision', customerId),
    );
    if (decision.status !== 'final' || decision.amountToCharge === null) {
      for (const issue of decision.issues ?? []) detail(`issue: ${issue.code} — ${issue.message}`);
      return null;
    }
    ctx.mainDecisionId = decision.id;
    return decision;
  }

  /** The decision-backed invoice payload (reused by create + validate). */
  private invoicePayloadFromDecision(customerId: string, taxDecisionId: string): unknown {
    return {
      type: 'standard',
      customerId,
      taxDecisionId,
      // Presentation only: the VAT comes from the decision.
      decisionLines: [
        { taxLineRef: 'conseil-heure', unit: 'hour' },
        { taxLineRef: 'abo-plateforme', unit: 'month' },
      ],
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

  /** The fiscal inputs of the recurring subscription (decided per occurrence). */
  private sampleSubscriptionTaxInputs(ctx: ScenarioContext): unknown {
    return {
      taxSource: 'facturino',
      priceMode: 'tax_exclusive',
      lines: [
        {
          reference: 'abo-mensuel',
          description: 'Abonnement Atelier — mensuel',
          category: 'electronically_supplied_services',
          rateCategory: 'standard',
          unitAmount: 4900,
          quantity: '1',
          unit: 'month',
          ...(ctx.subscriptionProductId ? { product: ctx.subscriptionProductId } : {}),
        },
      ],
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
   * Log a MANDATORY fiscal-journey failure. Unlike `softError`, these are
   * blocking: the phase stops where it failed, and `runAll` refuses to declare
   * the scenario complete. The decision-first journey is the point of this
   * demo — an error inside it is never an optional feature being unavailable.
   */
  private fiscalError(operation: string, err: unknown): void {
    this.fiscalFailures.push(operation);
    this.softError(operation, err);
  }

  /**
   * Record a BUSINESS block on the mandatory fiscal journey: the call itself
   * succeeded, but the decision is not `final`, so the journey cannot reach
   * its end. Distinct from `fiscalError` (a technical failure): the amounts of
   * a `pending_verification` decision are null — NOT zero — and nothing may be
   * charged or invoiced until the missing facts are supplied and re-decided.
   */
  private fiscalBlocked(operation: string, reason: string): void {
    this.fiscalFailures.push(`${operation} [business block: ${reason}]`);
    fail(`${operation}: blocked — ${reason} (not a technical failure)`);
  }

  /**
   * Log a non-fatal error and keep going. Reserved for explicitly OPTIONAL
   * features (plan-gated endpoints, state-machine conflicts on side quests):
   * their absence shouldn't abort the whole walkthrough. Always surfaces
   * `request_id` for support. Mandatory fiscal steps use `fiscalError`.
   */
  private softError(operation: string, err: unknown): void {
    if (err instanceof FacturinoError) {
      fail(`${operation}: ${err.toString()}`);
    } else {
      fail(`${operation}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
