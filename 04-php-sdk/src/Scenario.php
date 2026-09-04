<?php

declare(strict_types=1);

namespace AtelierDupont;

use Facturino\Account;
use Facturino\Billing;
use Facturino\Company;
use Facturino\CreditNote;
use Facturino\Customer;
use Facturino\Ereporting;
use Facturino\Event;
use Facturino\Exception\ApiException;
use Facturino\Export;
use Facturino\Invoice;
use Facturino\Job;
use Facturino\Payment;
use Facturino\TaxDecision;
use Facturino\Product;
use Facturino\Quote;
use Facturino\ReceivedInvoice;
use Facturino\RecurringInvoice;
use Facturino\Reference;
use Facturino\Reporting;
use Facturino\Sandbox;
use Facturino\Usage;
use Facturino\Validate;
use Facturino\WebhookEndpoint;

/**
 * Parcours "Atelier Dupont" — la meme histoire que les autres demos, du
 * bootstrap du compte (A) a l'administration (J).
 *
 * Chaque phase est une methode publique : on peut jouer tout le parcours
 * (runAll) ou une phase isolee via les routes HTTP /run/{phase}.
 *
 * Conventions respectees partout :
 *  - montants en centimes (10000 = 100,00 EUR), TVA en centiemes de pourcent
 *    (2000 = 20,00 %) ;
 *  - Idempotency-Key stable par etape sur chaque POST de creation ;
 *  - pagination par curseur (Collection auto-paginee du SDK) ;
 *  - les erreurs d'API sont capturees et journalisees avec leur request_id.
 */
final class Scenario
{
    private Console $log;
    private Idempotency $idem;
    private Config $config;

    /**
     * Etat partage entre phases (ids decouverts ou crees au fil du parcours).
     *
     * @var array<string, mixed>
     */
    private array $state = [];

    public function __construct(Config $config, ?string $runId = null)
    {
        $this->config = $config;
        $this->log = new Console();
        $this->idem = new Idempotency($runId);
    }

    public function log(): Console
    {
        return $this->log;
    }

    /**
     * Run the complete A -> K workflow in order.
     *
     * @return array<string, mixed> Resultat structure (runId + journal).
     */
    public function runAll(): array
    {
        $this->bootstrapAccount();      // A
        $this->catalogAndCustomer();    // B
        $this->quoteToInvoice();        // C
        $this->invoiceLifecycle();      // D
        $this->recurring();             // E
        $this->taxDecision();           // K
        $this->depositAndSchedule();    // K
        $this->decidedCreditNote();     // K
        $this->decidedRecurring();      // K
        $this->integrationDecision();   // K
        $this->creditNote();            // F
        $this->purchases();             // G
        $this->webhooksSetup();         // H
        $this->accountingAndPiloting(); // I
        $this->administration();        // J

        return $this->result();
    }

    /**
     * @return array<string, mixed>
     */
    public function result(): array
    {
        return [
            'run_id' => $this->idem->runId(),
            'steps' => $this->log->steps(),
        ];
    }

    // -----------------------------------------------------------------
    // A. Bootstrap du compte SaaS
    // -----------------------------------------------------------------

    public function bootstrapAccount(): void
    {
        // A1 — Qui suis-je : on verifie la cle, le plan et le livemode.
        $this->step('A1', 'account.retrieve — contexte du compte', function (): array {
            $account = Account::retrieve();
            $this->state['plan'] = $account['plan'] ?? null;
            $this->state['livemode'] = $account['livemode'] ?? null;

            return [
                'plan' => $account['plan'] ?? null,
                'livemode' => $account['livemode'] ?? null,
                'company' => $account['company']['id'] ?? ($account['companyId'] ?? null),
            ];
        });

        // A2 — Societe emettrice : on retient le premier company id.
        $this->step('A2', 'companies.list / companies.get — societe emettrice', function (): array {
            $companies = Company::all(['limit' => 1]);
            $first = $companies->getData()[0] ?? null;
            if ($first === null) {
                throw new ApiException('Aucune societe sur ce compte.');
            }
            $this->state['companyId'] = $first['id'];

            $company = Company::retrieve($first['id']);

            return ['companyId' => $company['id'], 'name' => $company['name'] ?? null];
        });

        // A2b — Administration societe : CGV (conditions generales) + jalon d'onboarding.
        $this->step('A2b', 'companies.uploadCgv / getCgv / deleteCgv + addMilestone', function (): array {
            $id = $this->companyId();
            // Les CGV sont envoyees en PDF encode en base64.
            $cgv = base64_encode("%PDF-1.4\n% Conditions generales de vente (demo)\n");
            Company::uploadCgv($id, $cgv);
            Company::getCgv($id);
            Company::deleteCgv($id);
            Company::addMilestone($id, 'firstInvoice');

            return ['companyId' => $id, 'milestone' => 'firstInvoice'];
        });

        // A3b — Referentiels INSEE pour alimenter les formulaires.
        $this->step('A3b', 'reference.listLegalForms / listNafCodes', function (): array {
            $legalForms = Reference::listLegalForms(['limit' => 3]);
            $naf = Reference::listNafCodes(['search' => 'conseil', 'limit' => 3]);

            return [
                'legalFormsPage' => count($legalForms),
                'nafPage' => count($naf),
            ];
        });

        // A4 — Quotas : consommation vs limites du plan.
        $this->step('A4', 'usage.retrieve — quotas du plan', function (): array {
            $usage = Usage::retrieve();

            return [
                'invoices' => $usage['invoices'] ?? ($usage['usage']['invoices'] ?? null),
                'plan' => $this->state['plan'] ?? null,
            ];
        });
    }

    // -----------------------------------------------------------------
    // B. Catalogue & client
    // -----------------------------------------------------------------

    public function catalogAndCustomer(): void
    {
        // B5 — Produits : un abonnement mensuel + une prestation a l'unite.
        $this->step('B5', 'products.create — abonnement mensuel', function (): array {
            $product = Product::create([
                'name' => 'Abonnement Atelier Dupont — Studio',
                'description' => 'Acces mensuel a l\'atelier partage',
                'category' => 'subscription',
                'unitPrice' => 9900,  // 99,00 EUR HT
                'vatRate' => 2000,    // 20,00 %
                'vatCode' => 'S',     // taux normal (CII BT-151)
                'unit' => 'month',
            ], $this->idem->key('B5-subscription'));
            $this->state['productSubscriptionId'] = $product['id'];

            return ['productId' => $product['id'], 'name' => $product['name'] ?? null];
        });

        $this->step('B5b', 'products.create — prestation a l\'unite', function (): array {
            $product = Product::create([
                'name' => 'Prestation conseil',
                'description' => 'Accompagnement projet, facture a l\'heure',
                'category' => 'service',
                'unitPrice' => 12000, // 120,00 EUR HT
                'vatRate' => 2000,
                'vatCode' => 'S',
                'unit' => 'hour',
            ], $this->idem->key('B5-consulting'));
            $this->state['productConsultingId'] = $product['id'];

            return ['productId' => $product['id']];
        });

        // B5c — Lecture / mise a jour / liste (pagination par curseur).
        $this->step('B5c', 'products.get / update / list (dont filtres q / category / active)', function (): array {
            $id = $this->state['productConsultingId'];
            Product::retrieve($id);
            Product::update($id, ['unitPrice' => 12500]); // 125,00 EUR

            $count = 0;
            foreach (Product::all(['limit' => 25]) as $_product) {
                $count++;
                if ($count >= 100) {
                    break; // garde-fou : ne pas defiler indefiniment
                }
            }

            // Liste filtree : q (recherche par prefixe de nom), category, active.
            // Ici on retrouve l'abonnement cree en B5 via q="abonnement".
            $filtered = Product::all([
                'q' => 'abonnement',
                'category' => 'subscription',
                'active' => true,
                'limit' => 25,
            ]);

            return ['productsSeen' => $count, 'matchedByFilter' => count($filtered)];
        });

        // B5d — Import / export CSV (jobs asynchrones).
        $this->step('B5d', 'products.importCsv / exportCsv', function (): array {
            // Import : CSV texte (en-tete + une ligne par produit), traitement
            // asynchrone (202 Accepted). Export : CSV brut (text/csv).
            Product::importCsv("name,unitPrice,vatRate,unit,vatCode\nForfait setup,30000,2000,flat_rate,S\n");
            $csv = Product::exportCsv();

            return ['exportBytes' => strlen($csv)];
        });

        // B6 — Client : lookup SIRENE/VIES puis lookup-or-create idempotent.
        $this->step('B6', 'customers.lookup — enrichissement SIRENE', function (): array {
            $lookup = Customer::lookup(['siret' => '55204944776279']); // SNCF (donnee publique d'exemple)
            $this->state['lookupResult'] = $lookup;

            return ['found' => isset($lookup['name']) || isset($lookup['data'])];
        });

        $this->step('B6b', 'customers.create — lookup-or-create idempotent', function (): array {
            // Idempotence metier : si un client identique a deja ete cree dans
            // ce run, l'Idempotency-Key cote API renvoie la meme ressource.
            $customer = Customer::create([
                'name' => 'Boulangerie Martin SARL',
                'type' => 'company',
                'email' => 'compta@boulangerie-martin.test',
                'siret' => '73282932000074',
                'address' => [
                    'line1' => '12 rue du Four',
                    'postalCode' => '69002',
                    'city' => 'Lyon',
                    'country' => 'FR',
                ],
                // Contact de facturation : recoit les factures par defaut (role billing).
                'contacts' => [
                    ['email' => 'compta@boulangerie-martin.test', 'role' => 'billing'],
                ],
            ], $this->idem->key('B6-customer'));
            $this->state['customerId'] = $customer['id'];

            return ['customerId' => $customer['id'], 'name' => $customer['name'] ?? null];
        });

        $this->step('B6c', 'customers.get / update / list', function (): array {
            $id = $this->customerId();
            Customer::retrieve($id);
            Customer::update($id, ['notes' => 'Client abonne — facturation mensuelle']);

            $count = 0;
            foreach (Customer::all(['limit' => 25]) as $_c) {
                $count++;
                if ($count >= 100) {
                    break;
                }
            }

            return ['customersSeen' => $count];
        });

        $this->step('B6d', 'customers.importCsv / exportCsv', function (): array {
            // Import : CSV texte (asynchrone, 202). Export : CSV brut (text/csv).
            // Les noms de colonnes sont ceux qu'emet customers.exportCsv : un
            // export doit se reimporter tel quel. Une adresse absente laisse un
            // client avec une adresse de remplacement, dont aucune decision
            // fiscale ne peut resoudre le territoire. Le SIRET est celui d'un
            // AUTRE etablissement : importer un second enregistrement sous le
            // SIRET du scenario masquerait son client au prochain lookup.
            Customer::importCsv(
                "name,email,siret,address_line1,address_postal_code,address_city,address_country\n"
                . "Cabinet Durand,contact@durand.test,44306184100047,8 rue de la Paix,69007,Lyon,FR\n"
            );
            $csv = Customer::exportCsv();

            return ['exportBytes' => strlen($csv)];
        });
    }

    // -----------------------------------------------------------------
    // C. Devis -> facture
    // -----------------------------------------------------------------

    public function quoteToInvoice(): void
    {
        // C7 — Devis : creation, envoi, acceptation, PDF, preuve, conversion.
        $this->step('C7', 'quotes.create — devis pour le client', function (): array {
            $quote = Quote::create([
                'customerId' => $this->customerId(),
                'lines' => [
                    [
                        'description' => 'Mise en place studio + 2h conseil',
                        'quantity' => '1',
                        'unit' => 'unit',
                        'unitPrice' => 30000, // 300,00 EUR HT
                        'vatRate' => 2000,
                        'vatCode' => 'S',
                    ],
                ],
                'dates' => [
                    'issued' => gmdate('Y-m-d'),
                    'validUntil' => gmdate('Y-m-d', strtotime('+30 days')),
                ],
            ], $this->idem->key('C7-quote'));
            $this->state['quoteId'] = $quote['id'];

            return ['quoteId' => $quote['id'], 'status' => $quote['status'] ?? null];
        });

        $this->step('C7b', 'quotes.send / get — envoi & relecture', function (): array {
            $id = $this->state['quoteId'];
            Quote::send($id);
            $quote = Quote::retrieve($id);

            return ['status' => $quote['status'] ?? null];
        });

        $this->step('C7c', 'quotes.accept / getPdf / getSignatureProof', function (): array {
            $id = $this->state['quoteId'];
            $accepted = Quote::accept($id);
            Quote::getPdf($id);

            // La preuve de signature n'existe qu'une fois le devis accepte ;
            // on tolere une indisponibilite (plan / signature non activee).
            $proof = null;
            try {
                $proof = Quote::getSignatureProof($id);
            } catch (ApiException $e) {
                $proof = ['unavailable' => $e->getMessage()];
            }

            return ['status' => $accepted['status'] ?? null, 'hasProof' => isset($proof['id'])];
        });

        // C7c2 — Re-proposer un devis similaire : clone le devis accepte en un
        // nouveau brouillon, sans toucher l'original. POST /v1/quotes/:id/clone.
        $this->step('C7c2', 'quotes.clone — re-proposition en brouillon', function (): array {
            $cloned = Quote::clone($this->state['quoteId']);
            $this->state['clonedQuoteId'] = $cloned['id'] ?? null;

            return ['clonedQuoteId' => $cloned['id'] ?? null, 'status' => $cloned['status'] ?? null];
        });

        $this->step('C7d', 'quotes.convert — devis accepte -> brouillon commercial', function (): array {
            $invoice = Quote::convert($this->state['quoteId']);
            // Le brouillon converti EST la facture du cycle D : sa TVA n'est pas
            // encore decidee (taxSource null). D9 decide cette meme operation,
            // adosse la decision a CE document, puis le finalise.
            $draft = $invoice['commercialDraft'] ?? null;
            if (!is_array($draft) || ($draft['lines'] ?? []) === []) {
                throw new \RuntimeException('quotes.convert a rendu un brouillon sans operation commerciale');
            }
            $this->state['convertedInvoiceId'] = $invoice['id'] ?? null;
            $this->state['convertedDraft'] = $draft;
            // La decision doit prendre effet a la date d'emission DU BROUILLON.
            $this->state['convertedIssuedOn'] = $invoice['dates']['issued'] ?? null;

            return ['invoiceId' => $invoice['id'] ?? null, 'status' => $invoice['status'] ?? null];
        });

        // C8 — Validation amont EN16931 sans rien emettre. Meme le dry-run est
        // decision-first : la decision est prise d'abord ; la validation ne
        // persiste rien et ne consomme pas la decision, que D9 reutilise.
        $this->step('C8', 'taxDecisions.create + validate.run — controle EN16931', function (): array {
            $decision = $this->decide($this->mainOperationLines(), 'C8-main-decision');
            if ($decision === null) {
                return ['skipped' => true, 'reason' => 'the decision is not final'];
            }
            $this->state['mainDecisionId'] = $decision['id'];
            $validation = Validate::run($this->invoicePayloadFromDecision($decision['id']));

            return [
                'valid' => $validation['valid'] ?? ($validation['ok'] ?? null),
                'issues' => count($validation['warnings'] ?? ($validation['errors'] ?? ($validation['issues'] ?? []))),
            ];
        });
    }

    // -----------------------------------------------------------------
    // D. Cycle de vie facture
    // -----------------------------------------------------------------

    public function invoiceLifecycle(): void
    {
        // D9 — La facture est celle que le DEVIS a produite. Son bloc commercial
        // est relu depuis la conversion : les references de ligne sont
        // attribuees cote serveur, et la decision doit enoncer exactement
        // l'operation portee par le brouillon. La decision est ensuite ADOSSEE a
        // ce meme document : en creer un second laisserait le brouillon converti
        // orphelin et romprait la filiation devis -> facture.
        $this->step('D9', 'taxDecisions.create + invoices.bindTaxDecision — brouillon converti', function (): array {
            $convertedId = $this->state['convertedInvoiceId'] ?? null;
            $draft = $this->state['convertedDraft'] ?? null;
            $issuedOn = $this->state['convertedIssuedOn'] ?? null;
            if (!is_string($convertedId) || !is_array($draft) || !is_string($issuedOn)) {
                throw new \RuntimeException('aucun brouillon converti : le cycle devis ne peut pas se poursuivre');
            }

            $decision = $this->decide($this->decisionLinesFromDraft($draft), 'D9-converted-decision', $issuedOn);
            if ($decision === null) {
                throw new \RuntimeException(sprintf(
                    "l'operation du brouillon %s n'est pas decidable : aucune facture n'est emise",
                    $convertedId
                ));
            }
            $this->state['mainDecisionId'] = $decision['id'];

            $invoice = Invoice::bindTaxDecision($convertedId, [
                'taxDecisionId' => $decision['id'],
                'decisionLines' => $this->presentationFromDraft($draft),
            ], $this->idem->key('D9-bind-decision'));
            $this->state['invoiceId'] = $invoice['id'];
            // Un avoir reference les lignes de la facture qu'il annule, et ces
            // references sont attribuees cote serveur a la conversion : celle
            // que la phase F credite est relue du document, jamais ecrite en dur.
            $this->state['mainLineRef'] = $draft['lines'][0]['reference'];

            return ['invoiceId' => $invoice['id'], 'status' => $invoice['status'] ?? null, 'taxSource' => $invoice['taxSource'] ?? null];
        });

        // D9b — Finaliser (numerotation atomique, irreversible).
        $this->step('D9b', 'invoices.finalize / get / getStatus / list (convertedFrom)', function (): array {
            $id = $this->invoiceId();
            $finalized = Invoice::finalize($id);
            Invoice::retrieve($id);
            $status = Invoice::getStatus($id);

            // Tracer le lien devis -> facture : retrouver les factures issues du
            // devis converti en C (filtre convertedFrom). GET /v1/invoices?convertedFrom=quo_...
            $fromQuote = null;
            if (isset($this->state['quoteId']) && is_string($this->state['quoteId'])) {
                $fromQuote = count(Invoice::all([
                    'convertedFrom' => $this->state['quoteId'],
                    'limit' => 25,
                ]));
            }

            return [
                'number' => $finalized['number'] ?? null,
                'status' => $status['status'] ?? ($finalized['status'] ?? null),
                'fromQuote' => $fromQuote,
            ];
        });

        // D10 — Documents : PDF, Factur-X, XML (CII + UBL), via jobs si async.
        $this->step('D10', 'invoices.getPdf / getFacturx / getXml (+ jobs.poll)', function (): array {
            $id = $this->invoiceId();
            $pdf = Invoice::getPdf($id);
            $pdfUrl = $this->resolveDocument($pdf);

            Invoice::getFacturx($id);
            $cii = Invoice::getXml($id, 'cii');
            $ubl = Invoice::getXml($id, 'ubl');

            return [
                'pdfReady' => $pdfUrl !== null,
                'ciiBytes' => strlen($cii),
                'ublBytes' => strlen($ubl),
            ];
        });

        // D11 — Depot a la PA (202 Accepted, asynchrone).
        $this->step('D11', 'invoices.send — depot a la PA', function (): array {
            $sent = Invoice::send($this->invoiceId());

            return ['accepted' => true, 'status' => $sent['status'] ?? null];
        });

        // D11b — En mode test : on force la transition de statut PA pour rendre
        // la chaine de webhooks deterministe (sandbox.simulateStatus).
        $this->step('D11b', 'sandbox.simulateStatus — avancer le statut PA', function (): array {
            $id = $this->invoiceId();
            $transitions = [];
            foreach (['deposited', 'transmitted', 'received', 'approved'] as $target) {
                try {
                    $res = Sandbox::simulateStatus($id, $target);
                    $transitions[] = $res['status'] ?? $target;
                } catch (ApiException $e) {
                    // Transition deja appliquee ou non autorisee par la machine
                    // a etats : on s'arrete proprement.
                    $transitions[] = $target . ' (skip: ' . $e->getMessage() . ')';
                    break;
                }
            }

            return ['transitions' => $transitions];
        });

        // D12 — Encaissement : liens de paiement Stripe puis paiement enregistre.
        $this->step('D12', 'invoices.createPaymentLink / createPortalLink', function (): array {
            $id = $this->invoiceId();
            $link = null;
            $portal = null;
            try {
                // Pro+ uniquement : on tolere un refus de plan.
                $payment = Invoice::createPaymentLink($id, [
                    'successUrl' => $this->config->publicBaseUrl . '/return?paid=1',
                    'cancelUrl' => $this->config->publicBaseUrl . '/return?paid=0',
                ]);
                $link = $payment['url'] ?? null;
                $portal = Invoice::createPortalLink($id)['url'] ?? null;
            } catch (ApiException $e) {
                return ['paymentLink' => null, 'note' => $e->getMessage()];
            }

            return ['paymentLink' => $link, 'portalLink' => $portal];
        });

        // D12c — Jeton de paiement signe pour un checkout embarque/headless (Pro+).
        $this->step('D12c', 'invoices.createPaymentToken', function (): array {
            $token = Invoice::createPaymentToken($this->invoiceId());

            return ['expiresAt' => $token['expiresAt'] ?? ($token['expires_at'] ?? null)];
        });

        $this->step('D12b', 'payments.create / payments.list', function (): array {
            $id = $this->invoiceId();
            Payment::create($id, [
                'amount' => 36000,   // 300,00 HT + 60,00 TVA = 360,00 EUR
                'method' => 'transfer',
                'reference' => 'VIR-2026-0001',
                'paidAt' => gmdate('Y-m-d'),
            ], $this->idem->key('D12-payment'));

            $count = 0;
            foreach (Payment::all($id, ['limit' => 25]) as $_p) {
                $count++;
            }

            return ['paymentsRecorded' => $count];
        });

        // D13 — Relance & evenements de cycle de vie.
        $this->step('D13', 'invoices.remind / listEvents', function (): array {
            $id = $this->invoiceId();
            try {
                Invoice::remind($id, ['level' => 1]);
            } catch (ApiException $e) {
                // Une facture deja payee ne se relance pas : comportement normal.
            }
            $events = Invoice::listEvents($id);

            return ['events' => count($events['data'] ?? $events ?? [])];
        });

        // D14 — Piste d'audit : chaine de hash + journal + PDF d'audit.
        $this->step('D14', 'invoices.verify / getAuditTrail / generateAuditTrailPdf', function (): array {
            $id = $this->invoiceId();
            $verify = Invoice::verify($id);
            Invoice::getAuditTrail($id, ['limit' => 10]);
            try {
                Invoice::generateAuditTrailPdf($id); // Pro+ (audit_trail)
            } catch (ApiException $e) {
                // plan insuffisant : tolere
            }

            return ['chainValid' => $verify['valid'] ?? ($verify['ok'] ?? null)];
        });

        // D15 — Clone (recurrence manuelle ponctuelle -> nouveau brouillon).
        $this->step('D15', 'invoices.clone — nouveau brouillon', function (): array {
            $clone = Invoice::clone($this->invoiceId());
            $this->state['clonedInvoiceId'] = $clone['id'] ?? null;

            return ['clonedId' => $clone['id'] ?? null, 'status' => $clone['status'] ?? null];
        });
    }

    // -----------------------------------------------------------------
    // E. Abonnement recurrent (coeur SaaS)
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // K. Decision-first billing
    // -----------------------------------------------------------------

    /**
     * Decide, collect the decided amount, verify after settlement, then invoice.
     *
     * The order is the point. The VAT and the exact amount to debit come from
     * Facturino BEFORE anything is collected, and the decision id travels with
     * the settlement so what was received can be checked against what was
     * decided.
     *
     * Facturino imposes no payment service provider and no payment method. The
     * flow below is provider-neutral: the decision id is carried in the payment
     * REFERENCE, which every settlement has — a transfer, a direct debit, a
     * cheque, cash, or a PSP capture. Two PSP variants are shown afterwards as
     * examples; both are simulated locally, and no PSP is ever contacted.
     */
    public function taxDecision(): void
    {
        $this->step('K1', 'taxDecisions.create — decide before charging', function (): array {
            $decision = TaxDecision::create([
                // Facturino determines the VAT; 'integration' is the other
                // journey, shown in integrationDecision() below.
                'taxSource' => 'facturino',
                'customerId' => $this->customerId(),
                // The effective date drives the applicable rules, not the clock.
                'effectiveAt' => gmdate('Y-m-d'),
                'currency' => 'eur',
                'priceMode' => 'tax_exclusive',
                'lines' => [[
                    'reference' => 'abo-pro',
                    'description' => 'Abonnement Atelier Dupont — Studio',
                    // A subscription delivered online is an electronically
                    // supplied service: it carries its own place-of-supply rules.
                    'category' => 'electronically_supplied_services',
                    'rateCategory' => 'standard',
                    'unitAmount' => 9900, // integer cents
                    'quantity' => '1',    // decimal STRING, never a float
                ]],
            ], $this->idem->key('K1-tax-decision'));

            $this->state['taxDecisionId'] = $decision['id'];
            $this->state['taxDecisionStatus'] = $decision['status'];

            return ['taxDecisionId' => $decision['id'], 'status' => $decision['status']];
        });

        // Stop immediately unless the decision is final. "pending_verification"
        // does not mean "nothing to charge": the amounts are null, not 0.
        if (($this->state['taxDecisionStatus'] ?? null) !== 'final') {
            $this->step('K2', 'decision is not final — nothing charged, no invoice', fn (): array => [
                'status' => $this->state['taxDecisionStatus'] ?? null,
            ]);

            return;
        }

        $this->step('K3', 'settlement (simulated) — collect exactly the decided amount', function (): array {
            $decision = TaxDecision::retrieve($this->state['taxDecisionId']);
            $amount = $decision['amountToCharge'];

            // Every settlement has a reference: a transfer wording, a
            // direct-debit mandate reference, a cheque number, a PSP charge id.
            // That reference is what lets K4 verify what was actually received.
            $this->state['settledAmount'] = $amount;
            $this->state['settledCurrency'] = $decision['currency'];
            $this->state['settledCustomerId'] = $decision['customerId'];
            $this->state['settlementReference'] = $decision['id'];
            // transfer, card, check, cash, direct_debit, sepa, paypal or other
            $this->state['settlementMethod'] = 'transfer';

            return [
                'amount_cents' => $amount,
                'currency' => $decision['currency'],
                'method' => $this->state['settlementMethod'],
                'reference' => $this->state['settlementReference'],
                // OPTIONAL, for a PSP-collected payment. Two examples, nothing
                // more: Facturino requires neither, and nothing is sent here.
                'optional_psp_variants' => [
                    'stripe_metadata' => ['facturino_tax_decision_id' => $decision['id']],
                    'paypal_custom_id' => $decision['id'],
                    // PayPal reasons in decimal units, so convert from cents.
                    'paypal_value' => number_format($amount / 100, 2, '.', ''),
                ],
            ];
        });

        $this->step('K4', 'taxDecisions.retrieve — verify the settlement', function (): array {
            // Read the decision back from the reference carried with the payment.
            $source = TaxDecision::retrieve($this->state['settlementReference']);

            // Amount, currency and buyer must match, or the settlement and the
            // invoice would not describe the same operation.
            if (($this->state['settledAmount'] ?? null) !== $source['amountToCharge']) {
                throw new \RuntimeException('settled amount differs from the decision');
            }
            if (($this->state['settledCurrency'] ?? null) !== $source['currency']) {
                throw new \RuntimeException('settled currency differs from the decision');
            }
            if (($this->state['settledCustomerId'] ?? null) !== $source['customerId']) {
                throw new \RuntimeException('settled buyer differs from the decision');
            }
            $this->state['decidedAmount'] = $source['amountToCharge'];

            return [
                'amountToCharge' => $source['amountToCharge'],
                'currency' => $source['currency'],
                'invoiceChannel' => $source['invoiceChannel'] ?? null,
                'transactionReporting' => $source['transactionReporting'] ?? null,
                'paymentReporting' => $source['paymentReporting'] ?? null,
                'foreignTaxReviewRequired' => $source['foreignTaxReviewRequired'] ?? null,
            ];
        });

        $this->step('K5', 'invoices.create — backed by the decision', function (): array {
            $source = TaxDecision::retrieve($this->state['taxDecisionId']);

            // No VAT is restated: a decided line is referenced, and the document
            // line carries presentation only.
            $invoice = Invoice::create([
                'customerId' => $source['customerId'],
                'taxDecisionId' => $source['id'],
                'decisionLines' => [['taxLineRef' => 'abo-pro', 'unit' => 'month']],
                'buyer' => $this->buyerBlock(),
                'dates' => ['issued' => gmdate('Y-m-d'), 'due' => gmdate('Y-m-d', strtotime('+30 days'))],
                'payment' => $this->paymentTerms(),
            ], $this->idem->key('K5-decided-invoice'));

            // Finalize WITH the collection. The money was received at K3 and
            // verified at K4, so the invoice is issued acquitted: the number
            // and the payment are applied in the SAME transaction, and the
            // original Factur-X is rendered on a settled document instead of
            // one that says "to pay". A collection above what is due is
            // refused (payment_exceeds_amount_due) and the invoice then stays
            // a draft — no number is burned.
            $finalized = Invoice::finalize($invoice['id'], [
                'amount' => $this->state['settledAmount'],
                'method' => $this->state['settlementMethod'],
                'reference' => $this->state['settlementReference'],
                'paidAt' => gmdate('Y-m-d'),
            ]);
            $this->state['decidedInvoiceId'] = $finalized['id'];

            return [
                'invoiceId' => $finalized['id'],
                'number' => $finalized['number'] ?? null,
                'taxSource' => $finalized['taxSource'] ?? null,
                // The three status axes, read off the invoice AS ISSUED.
                'documentStatus' => $finalized['documentStatus'] ?? null,
                'transmissionStatus' => $finalized['transmissionStatus'] ?? null,
                'paymentStatus' => $finalized['paymentStatus'] ?? null,
                'expectedPaymentStatus' => 'paid',
                // The REAL collection date, carried by the invoice itself.
                'paidAt' => $finalized['dates']['paidAt'] ?? null,
            ];
        });

        $this->step('K6', 'invoices.send — only on the decided channel', function (): array {
            $source = TaxDecision::retrieve($this->state['taxDecisionId']);
            if (($source['invoiceChannel'] ?? null) !== 'einvoicing') {
                // Not a failure: the operation is simply outside the e-invoicing
                // channel. Calling invoices.send here would be refused.
                return [
                    'sent' => false,
                    'invoiceChannel' => $source['invoiceChannel'] ?? null,
                    'note' => 'the obligation, if any, goes through e-reporting',
                ];
            }

            Invoice::send($this->state['decidedInvoiceId']);

            return ['sent' => true, 'invoiceChannel' => 'einvoicing'];
        });

        // Nothing is recorded here: the collection was applied with the
        // finalization. This reads the ledger back and proves it is there,
        // with the reference that carries the decision id.
        $this->step('K6b', 'payments.all — the collection applied at finalization', function (): array {
            $ledger = Payment::all($this->state['decidedInvoiceId']);

            return [
                'count' => $ledger->count(),
                'entries' => array_map(static fn (array $entry): array => [
                    'amount' => $entry['amount'] ?? null,
                    'method' => $entry['method'] ?? null,
                    'reference' => $entry['reference'] ?? null,
                ], $ledger->getData()),
            ];
        });
    }

    /**
     * Deposit invoice (386), settled, then deducted from the balance invoice.
     *
     * The order matters and is the point: a deposit is deducted as PREPAID
     * (BT-113), and an amount is only prepaid once it has actually been
     * collected. The deposit is therefore decided, then ISSUED SETTLED —
     * finalization and full payment in one call — before it is attached to the
     * balance invoice. A deposit that is merely finalized has been invoiced,
     * not paid; issued acquitted, it never exists in that state at all.
     */
    public function depositAndSchedule(): void
    {
        $this->step('K7', 'taxDecisions.create + invoices.create (386) + finalize with full payment', function (): array {
            // A `deposit` line names the principal supply it follows.
            $depositDecision = $this->decide([[
                'reference' => 'acompte-prestation',
                'description' => 'Prestation — acompte',
                'category' => 'deposit',
                'relatedCategory' => 'services',
                'rateCategory' => 'standard',
                'unitAmount' => 24000,
                'quantity' => '1',
            ]], 'K7-deposit-decision');
            if ($depositDecision === null) {
                return ['skipped' => true, 'reason' => 'the deposit decision is not final'];
            }
            $this->state['depositDecisionAmount'] = $depositDecision['amountToCharge'];

            $draft = Invoice::create([
                'customerId' => $this->customerId(),
                'type' => 'deposit',
                'buyer' => $this->buyerBlock(),
                'taxDecisionId' => $depositDecision['id'],
                'decisionLines' => [['taxLineRef' => 'acompte-prestation', 'unit' => 'unit']],
                'dates' => ['issued' => gmdate('Y-m-d'), 'due' => gmdate('Y-m-d', strtotime('+30 days'))],
                'payment' => $this->paymentTerms(),
            ], $this->idem->key('K7-deposit'));

            // Finalize WITH the payment IN FULL — exactly the decided amount,
            // in a single call. An amount is only prepaid once it has been
            // collected, and issuing the deposit acquitted is the strongest
            // form of that rule: the deposit never exists unpaid, so it can
            // never be deducted before it was settled.
            $deposit = Invoice::finalize($draft['id'], [
                'amount' => $depositDecision['amountToCharge'],
                'method' => 'transfer',
                'reference' => $depositDecision['id'],
                'paidAt' => gmdate('Y-m-d'),
            ]);

            // The settlement is read off the ISSUED deposit, not fetched after.
            $this->state['depositInvoiceId'] = $deposit['id'];
            $this->state['depositSettled'] = (($deposit['paymentStatus'] ?? $deposit['status'] ?? null) === 'paid');

            return [
                'depositId' => $deposit['id'],
                'number' => $deposit['number'] ?? null,
                'settled' => $this->state['depositSettled'],
                'paidAt' => $deposit['dates']['paidAt'] ?? null,
            ];
        });

        $this->step('K8', 'invoices.create — balance with the SETTLED deposit + schedule', function (): array {
            if (($this->state['depositSettled'] ?? false) !== true) {
                // Attaching an unsettled deposit would misstate BT-113.
                return ['skipped' => true, 'reason' => 'the deposit is not settled'];
            }

            $balanceDecision = $this->decide([[
                'reference' => 'prestation-atelier',
                'description' => 'Prestation d\'atelier',
                'category' => 'services',
                'rateCategory' => 'standard',
                'unitAmount' => 8000,
                'quantity' => '10',
            ]], 'K8-balance-decision');
            if ($balanceDecision === null) {
                return ['skipped' => true, 'reason' => 'the balance decision is not final'];
            }

            // Deposits and schedule settle SERVER-SIDE against the decided
            // amount: the instalments distribute exactly what remains due after
            // the prepaid deposit (BT-113/BT-115), the last one on the due
            // date (BT-9).
            $stillDue = $balanceDecision['amountToCharge'] - (int) $this->state['depositDecisionAmount'];
            $firstInstalment = intdiv($stillDue, 2);
            $draft = Invoice::create([
                'customerId' => $this->customerId(),
                'buyer' => $this->buyerBlock(),
                'taxDecisionId' => $balanceDecision['id'],
                'decisionLines' => [['taxLineRef' => 'prestation-atelier', 'unit' => 'hour']],
                'dates' => ['issued' => gmdate('Y-m-d'), 'due' => gmdate('Y-m-d', strtotime('+30 days'))],
                'payment' => $this->paymentTerms(),
                'deposits' => [['invoiceId' => $this->state['depositInvoiceId']]],
                'schedule' => [
                    ['amount' => $firstInstalment, 'dueDate' => gmdate('Y-m-d', strtotime('+15 days')), 'label' => 'Premier versement'],
                    ['amount' => $stillDue - $firstInstalment, 'dueDate' => gmdate('Y-m-d', strtotime('+30 days')), 'label' => 'Solde'],
                ],
            ], $this->idem->key('K8-balance'));

            $balance = Invoice::finalize($draft['id']);

            return [
                'invoiceId' => $balance['id'],
                'totalTTC' => $balance['totals']['totalTTC'] ?? null,
                'amountPaid' => $balance['totals']['amountPaid'] ?? null,
                'amountDue' => $balance['totals']['amountDue'] ?? null,
            ];
        });
    }

    /**
     * Credit a DECIDED invoice through `creditedLines`.
     *
     * The rate, the category, the VATEX code and the legal mention are
     * inherited from the invoice's frozen snapshot; restating them through
     * There is no way to restate them.
     */
    public function decidedCreditNote(): void
    {
        $this->step('K9', 'creditNotes.create — creditedLines on a decided invoice', function (): array {
            if (!isset($this->state['decidedInvoiceId'])) {
                return ['skipped' => true, 'reason' => 'no decided invoice in this run'];
            }

            $creditNote = CreditNote::create([
                'relatedInvoiceId' => $this->state['decidedInvoiceId'],
                'creditNoteType' => 'partial',
                'reasonCode' => 'quality',
                'reason' => 'Partial credit on a decided invoice',
                // Either `quantity` or `amountTTC`, never both. Omitting both
                // credits the line's whole remaining balance.
                'creditedLines' => [['taxLineRef' => 'abo-pro', 'amountTTC' => 1200]],
                'dates' => ['issued' => gmdate('Y-m-d')],
            ], $this->idem->key('K9-decided-credit-note'));

            return [
                'creditNoteId' => $creditNote['id'],
                'originalTaxDecisionId' => $creditNote['originalTaxDecisionId'] ?? null,
            ];
        });
    }

    /**
     * A recurrence on the decided journey.
     *
     * `taxInputs` carries the OPERATION, not a decision: a recurrence never
     * stores one. Each occurrence is decided on its own effective date, so a
     * schedule created today does not carry this quarter's rules into next year.
     */
    public function decidedRecurring(): void
    {
        $this->step('K10', 'recurringInvoices.create — taxInputs, decided per occurrence', function (): array {
            $recurring = RecurringInvoice::create([
                'customerId' => $this->customerId(),
                'frequency' => 'monthly',
                'startDate' => gmdate('Y-m-d'),
                'nextGenerationDate' => gmdate('Y-m-d', strtotime('+1 month')),
                'taxInputs' => [
                    'taxSource' => 'facturino',
                    'priceMode' => 'tax_exclusive',
                    'lines' => [[
                        'reference' => 'abo-pro',
                        'description' => 'Abonnement Atelier Dupont — Studio',
                        'category' => 'electronically_supplied_services',
                        'rateCategory' => 'standard',
                        'unitAmount' => 9900,
                        'quantity' => '1',
                        'unit' => 'month',
                    ]],
                ],
                // `templateInvoice` carries presentation and terms only —
                // never a line, never a rate.
                'templateInvoice' => ['paymentMethod' => 'transfer', 'paymentTermsDays' => 30],
            ], $this->idem->key('K10-decided-recurring'));

            return ['recurringId' => $recurring['id']];
        });
    }

    /**
     * K11 — The OTHER fiscal journey: the VAT is supplied by the integration.
     *
     * An ERP or an in-house rules service that already determines the VAT
     * declares it on the decision (`taxSource: integration`). Facturino
     * validates the coherence of what is supplied and refuses contradictions
     * (`integration_vat_incoherent`) — it never silently corrects a rate. The
     * decision, the invoice and the reporting obligations then work exactly
     * as on the `facturino` source: the two journeys are equals.
     */
    public function integrationDecision(): void
    {
        $this->step('K11', 'taxDecisions.create — VAT supplied by the integration', function (): array {
            $decision = TaxDecision::create([
                'taxSource' => 'integration',
                'customerId' => $this->customerId(),
                'effectiveAt' => gmdate('Y-m-d'),
                'currency' => 'eur',
                'priceMode' => 'tax_exclusive',
                'lines' => [[
                    'reference' => 'conseil-integ',
                    'description' => 'Prestation de conseil (TVA fournie par l\'ERP)',
                    'category' => 'services',
                    'unitAmount' => 10000,
                    'quantity' => '1',
                    'vatRate' => 2000, // 20,00 % — concluded by YOUR system
                    'vatCode' => 'S',
                ]],
            ], $this->idem->key('K11-integration-decision'));

            if (($decision['status'] ?? null) !== 'final' || ($decision['amountToCharge'] ?? null) === null) {
                return ['skipped' => true, 'status' => $decision['status'] ?? null];
            }

            $invoice = Invoice::create([
                'customerId' => $this->customerId(),
                'buyer' => $this->buyerBlock(),
                'taxDecisionId' => $decision['id'],
                'decisionLines' => [['taxLineRef' => 'conseil-integ', 'unit' => 'unit']],
                'dates' => ['issued' => gmdate('Y-m-d'), 'due' => gmdate('Y-m-d', strtotime('+30 days'))],
                'payment' => $this->paymentTerms(),
            ], $this->idem->key('K11-integration-invoice'));
            $finalized = Invoice::finalize($invoice['id']);

            return [
                'taxSource' => $finalized['taxSource'] ?? null,
                'invoiceId' => $finalized['id'],
                'number' => $finalized['number'] ?? null,
            ];
        });

        $this->step('K11b', 'incoherent supplied VAT is refused, never corrected', function (): array {
            try {
                TaxDecision::create([
                    'taxSource' => 'integration',
                    'customerId' => $this->customerId(),
                    'effectiveAt' => gmdate('Y-m-d'),
                    'currency' => 'eur',
                    'priceMode' => 'tax_exclusive',
                    'lines' => [[
                        'reference' => 'incoherent',
                        'description' => 'Ligne incoherente (demonstration du refus)',
                        'category' => 'services',
                        'unitAmount' => 10000,
                        'quantity' => '1',
                        // A positive rate cannot carry an exemption code.
                        'vatRate' => 2000,
                        'vatCode' => 'S',
                        'vatexCode' => 'VATEX-EU-G',
                    ]],
                ], $this->idem->key('K11b-incoherent'));

                return ['refused' => false, 'unexpected' => 'the contradiction was accepted'];
            } catch (\Facturino\Exception\InvalidRequestException $e) {
                return ['refused' => true, 'code' => 'integration_vat_incoherent'];
            }
        });
    }

    public function recurring(): void
    {
        $this->step('E16', 'recurringInvoices.create — abonnement mensuel', function (): array {
            // `taxInputs` porte l'operation et sa source fiscale ; chaque
            // echeance est decidee a sa propre date de generation.
            $recurring = RecurringInvoice::create([
                'customerId' => $this->customerId(),
                'frequency' => 'monthly',
                'startDate' => gmdate('Y-m-d'),
                'nextGenerationDate' => gmdate('Y-m-d', strtotime('+1 month')),
                'taxInputs' => [
                    'taxSource' => 'facturino',
                    'priceMode' => 'tax_exclusive',
                    'lines' => [[
                        'reference' => 'abo-studio',
                        'description' => 'Abonnement Atelier Dupont — Studio',
                        'category' => 'electronically_supplied_services',
                        'rateCategory' => 'standard',
                        'unitAmount' => 9900, // 99,00 EUR HT
                        'quantity' => '1',
                        'unit' => 'month',
                    ]],
                ],
                // Presentation et conditions uniquement — jamais une ligne.
                'templateInvoice' => [
                    'paymentMethod' => 'transfer',
                    'paymentTermsDays' => 30,
                ],
            ], $this->idem->key('E16-recurring'));
            $this->state['recurringId'] = $recurring['id'];

            return ['recurringId' => $recurring['id'], 'frequency' => 'monthly'];
        });

        $this->step('E16b', 'recurringInvoices.get / update / list', function (): array {
            $id = $this->state['recurringId'];
            RecurringInvoice::retrieve($id);
            // Activer l'automatisation : finalisation + envoi a chaque echeance.
            RecurringInvoice::update($id, ['autoFinalize' => true, 'autoSend' => true]);

            $count = 0;
            foreach (RecurringInvoice::all(['limit' => 25]) as $_r) {
                $count++;
            }

            return ['schedulesSeen' => $count];
        });

        $this->step('E16c', 'recurringInvoices.pause / resume', function (): array {
            $id = $this->state['recurringId'];
            RecurringInvoice::pause($id);
            $resumed = RecurringInvoice::resume($id);

            return ['status' => $resumed['status'] ?? null];
        });
    }

    // -----------------------------------------------------------------
    // F. Avoir
    // -----------------------------------------------------------------

    public function creditNote(): void
    {
        $this->step('F17', 'creditNotes.create — avoir lie a la facture', function (): array {
            // `creditedLines` reference les lignes DECIDEES de la facture : le
            // taux, la categorie, le code VATEX et la mention legale sont
            // herites du snapshot fige, jamais reformules.
            $credit = CreditNote::create([
                'relatedInvoiceId' => $this->invoiceId(), // BT-25 : avoir rattache a la facture emise
                'creditNoteType' => 'partial',
                'reasonCode' => 'other',
                'reason' => 'Remise commerciale exceptionnelle',
                'creditedLines' => [
                    // La reference d'une ligne DE LA FACTURE creditee : elle est
                    // attribuee cote serveur quand la facture vient d'un devis.
                    ['taxLineRef' => $this->state['mainLineRef'], 'amountTTC' => 6000], // 50,00 EUR HT + TVA
                ],
                'dates' => [
                    'issued' => gmdate('Y-m-d'),
                ],
            ], $this->idem->key('F17-credit'));
            $this->state['creditNoteId'] = $credit['id'];

            return ['creditNoteId' => $credit['id'], 'status' => $credit['status'] ?? null];
        });

        $this->step('F17b', 'creditNotes.finalize / send / getPdf / getFacturx', function (): array {
            $id = $this->state['creditNoteId'] ?? null;
            if (!is_string($id)) {
                return ['skipped' => true, 'reason' => 'aucun avoir cree a l etape precedente'];
            }
            $finalized = CreditNote::finalize($id);
            try {
                CreditNote::send($id); // depot PA (PA integree, Essential+)
            } catch (ApiException $e) {
                // depot manuel / plan : tolere
            }
            CreditNote::getPdf($id);
            CreditNote::getFacturx($id);

            return ['number' => $finalized['number'] ?? null];
        });

        // F17c — Facture avec ses avoirs lies : invoices.get expand=credit_notes
        // ramene les avoirs rattaches + le solde net (TTC - avoirs) en un appel.
        // GET /v1/invoices/:id?expand=credit_notes.
        $this->step('F17c', 'invoices.get expand=credit_notes — avoirs lies + solde net', function (): array {
            $expanded = Invoice::retrieve($this->invoiceId(), ['expand' => 'credit_notes']);
            $linked = $expanded['expanded']['credit_notes'] ?? [];

            return [
                'linkedCreditNotes' => count($linked),
                'netBalance' => $expanded['expanded']['net_balance'] ?? null,
            ];
        });
    }

    // -----------------------------------------------------------------
    // G. Achats (factures recues)
    // -----------------------------------------------------------------

    public function purchases(): void
    {
        $this->step('G18', 'invoices.createIncoming / listIncoming', function (): array {
            // Saisie manuelle d'une facture fournisseur recue hors PA :
            // emetteur + montant TTC + reference de la piece.
            $incoming = Invoice::createIncoming([
                'senderName' => 'Fournitures Pro SAS',
                'senderSiret' => '55208131766522',
                'amount' => 24000, // 240,00 EUR TTC
                'reference' => 'F-EXT-2026-512',
            ]);
            $this->state['incomingId'] = $incoming['id'] ?? null;

            $count = 0;
            foreach (Invoice::listIncoming(['limit' => 25]) as $_i) {
                $count++;
            }

            return ['incomingId' => $incoming['id'] ?? null, 'incomingSeen' => $count];
        });

        $this->step('G18b', 'receivedInvoices.list / get / approve / recordPayment', function (): array {
            // Les factures recues via la PA apparaissent dans /received-invoices.
            $received = ReceivedInvoice::all(['limit' => 1]);
            $first = $received->getData()[0] ?? null;
            if ($first === null) {
                throw new ApiException('Aucune facture recue (en attente de depot PA).');
            }
            $id = $first['id'];
            ReceivedInvoice::retrieve($id);

            $actions = [];
            try {
                ReceivedInvoice::approve($id); // fr:205
                $actions[] = 'approved';
                ReceivedInvoice::recordPayment($id, [
                    'amount' => $first['totalInclVat'] ?? 24000,
                    'method' => 'transfer',
                    'paidAt' => gmdate('Y-m-d'),
                ]); // fr:212
                $actions[] = 'paid';
            } catch (ApiException $e) {
                $actions[] = 'skip: ' . $e->getMessage();
            }

            // refuse / suspend sont codes ici a titre documentaire : on ne les
            // declenche pas sur une facture qu'on vient d'approuver.
            // ReceivedInvoice::refuse($id, ['reason' => 'Litige sur quantites']);
            // ReceivedInvoice::suspend($id);

            return ['receivedId' => $id, 'actions' => $actions];
        });
    }

    // -----------------------------------------------------------------
    // H. Webhooks
    // -----------------------------------------------------------------

    public function webhooksSetup(): void
    {
        $this->step('H19', 'webhookEndpoints.create / list / test', function (): array {
            if ($this->config->publicBaseUrl === '') {
                $this->log->skipped('H19', 'webhookEndpoints.create', 'PUBLIC_BASE_URL non defini (tunnel requis).');

                return [];
            }

            $endpoint = WebhookEndpoint::create([
                'url' => $this->config->publicBaseUrl . '/webhooks',
                'events' => [
                    'invoice.finalized',
                    'invoice.transmitted',
                    'invoice.paid',
                    'quote.accepted',
                ],
                'description' => 'Atelier Dupont — demo PHP',
            ], $this->idem->key('H19-endpoint'));
            $this->state['webhookEndpointId'] = $endpoint['id'] ?? null;

            $count = 0;
            foreach (WebhookEndpoint::all(['limit' => 25]) as $_e) {
                $count++;
            }

            // Le secret de signature n'est visible qu'a la creation : on le
            // copie dans FACTURINO_WEBHOOK_SECRET pour /webhooks.
            $secret = $endpoint['secret'] ?? ($endpoint['signingSecret'] ?? null);
            if (is_string($this->state['webhookEndpointId'])) {
                WebhookEndpoint::test($this->state['webhookEndpointId']);
            }

            return [
                'endpointId' => $endpoint['id'] ?? null,
                'endpointsSeen' => $count,
                'secretIssued' => $secret !== null,
            ];
        });

        // H21 — Rejeu : lister, lire, retenter un event.
        $this->step('H21', 'events.list / get / retry', function (): array {
            $events = Event::all(['limit' => 5]);
            $first = $events->getData()[0] ?? null;
            $retried = null;
            if ($first !== null) {
                Event::retrieve($first['id']);
                try {
                    Event::retry($first['id']);
                    $retried = $first['id'];
                } catch (ApiException $e) {
                    // event deja livre : retry non applicable
                }
            }

            return ['eventsSeen' => count($events), 'retried' => $retried];
        });
    }

    // -----------------------------------------------------------------
    // I. Comptabilite & pilotage
    // -----------------------------------------------------------------

    public function accountingAndPiloting(): void
    {
        $periodStart = gmdate('Y-01-01');
        $periodEnd = gmdate('Y-12-31');

        $this->step('I22', 'reporting.vat / reporting.revenue', function () use ($periodStart, $periodEnd): array {
            $vat = Reporting::vat(['period_start' => $periodStart, 'period_end' => $periodEnd]);
            $revenue = Reporting::revenue([
                'period_start' => $periodStart,
                'period_end' => $periodEnd,
                'group_by' => 'month',
            ]);

            return [
                'vatDue' => $vat['totalVat'] ?? ($vat['vatDue'] ?? null),
                'revenue' => $revenue['total'] ?? ($revenue['revenue'] ?? null),
            ];
        });

        $this->step('I23', 'exports.generateFec / getFecStatus / exportInvoices', function () use ($periodStart, $periodEnd): array {
            $fec = null;
            try {
                $fecJob = Export::generateFec([
                    'period_start' => $periodStart,
                    'period_end' => $periodEnd,
                ]);
                $jobId = $fecJob['id'] ?? ($fecJob['jobId'] ?? null);
                if (is_string($jobId)) {
                    $fec = Export::getFecStatus($jobId)['status'] ?? 'pending';
                }
            } catch (ApiException $e) {
                $fec = 'skip: ' . $e->getMessage(); // fec_export = Pro+
            }

            $invoicesExport = Export::exportInvoices([
                'period_start' => $periodStart,
                'period_end' => $periodEnd,
            ]);

            // L'export RGPD du compte est couvert par account.requestExport (J30).
            return [
                'fec' => $fec,
                'invoicesExportJob' => $invoicesExport['id'] ?? ($invoicesExport['jobId'] ?? null),
            ];
        });

        $this->step('I24', 'ereporting.create / list / get / submit', function (): array {
            $declaration = null;
            try {
                // E-reporting de transactions B2C : periode mensuelle (YYYY-MM)
                // et lignes agregees par categorie de TVA.
                $declaration = Ereporting::createDeclaration([
                    'type' => 'b2c',
                    'period' => gmdate('Y-m'),
                    'lines' => [
                        [
                            'category' => 'Ventes au comptoir',
                            'amount' => 150000,   // 1 500,00 EUR HT
                            'vatRate' => 2000,    // 20,00 %
                            'vatAmount' => 30000, // 300,00 EUR TVA
                        ],
                    ],
                ], $this->idem->key('I24-declaration'));
                $id = $declaration['id'] ?? null;
                if (is_string($id)) {
                    Ereporting::retrieve($id);
                    Ereporting::submitDeclaration($id);
                }
            } catch (ApiException $e) {
                return ['declaration' => 'skip: ' . $e->getMessage()];
            }

            $count = 0;
            foreach (Ereporting::all(['limit' => 25]) as $_d) {
                $count++;
            }

            return ['declarationId' => $declaration['id'] ?? null, 'declarationsSeen' => $count];
        });

        $this->step('I25', 'archives.list / get', function (): array {
            // Pas d'alias top-level pour Archive dans le SDK : on cible la
            // classe ressource directement (\Facturino\Resource\Archive).
            try {
                $archives = \Facturino\Resource\Archive::all(['limit' => 5]);
                $first = $archives->getData()[0] ?? null;
                if ($first !== null && isset($first['invoiceId'])) {
                    \Facturino\Resource\Archive::retrieve($first['invoiceId']);
                }

                return ['archivesSeen' => count($archives)];
            } catch (ApiException $e) {
                return ['archives' => 'skip: ' . $e->getMessage()]; // addon Archive
            }
        });
    }

    // -----------------------------------------------------------------
    // J. Administration du compte
    // -----------------------------------------------------------------

    public function administration(): void
    {
        // J29 — Facturation Facturino (abonnement de la plateforme), en lecture.
        $this->step('J29', 'billing.retrieveSubscription / listInvoices / getInvoicePdf', function (): array {
            $subscription = Billing::retrieveSubscription();

            $invoices = Billing::listInvoices(['limit' => 5]);
            $first = $invoices->getData()[0] ?? null;
            if ($first !== null && isset($first['id'])) {
                Billing::getInvoicePdf($first['id']);
            }

            return [
                'plan' => $subscription['plan'] ?? null,
                'status' => $subscription['status'] ?? null,
                'platformInvoices' => count($invoices),
            ];
        });

        // J30 — RGPD : export des donnees du compte.
        $this->step('J30', 'account.requestExport / downloadExport', function (): array {
            $export = Account::requestExport();
            $exportId = $export['exportId'] ?? ($export['id'] ?? null);

            // downloadExport ne reussit qu'une fois l'export prepare (async) ;
            // on tente, on tolere un 404/409 si pas encore pret.
            $downloadUrl = null;
            if (is_string($exportId)) {
                try {
                    $downloadUrl = Account::downloadExport($exportId)['url'] ?? null;
                } catch (ApiException $e) {
                    $downloadUrl = null; // export pas encore pret
                }
            }

            return ['exportId' => $exportId, 'downloadReady' => $downloadUrl !== null];
        });
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    /**
     * Execute une etape en capturant toute exception et en l'inscrivant au
     * journal avec son request_id. Le scenario continue meme en cas d'echec
     * d'une etape : on veut un parcours complet et un rapport exploitable.
     *
     * @param callable():array<string, mixed> $fn
     */
    private function step(string $code, string $label, callable $fn): void
    {
        try {
            $summary = $fn();
            $this->log->ok($code, $label, $summary);
        } catch (\Throwable $e) {
            $this->log->failed($code, $label, $e);
        }
    }

    /**
     * Payload de facture reutilise par validate.run (C8) et invoices.create
     * (D9). Inclut un acheteur (BG-7) et un numero de commande (BT-13).
     *
     * @return array<string, mixed>
     */
    /**
     * Take a `facturino`-source decision on the given commercial lines.
     * Returns null unless the decision is final: `pending_verification` means
     * "cannot conclude yet", never "0".
     *
     * @param array<int, array<string, mixed>> $lines
     * @return array<string, mixed>|null
     */
    private function decide(array $lines, string $keySuffix, ?string $effectiveAt = null): ?array
    {
        $decision = TaxDecision::create([
            'taxSource' => 'facturino',
            'customerId' => $this->customerId(),
            // Quand la decision fiscalise un brouillon EXISTANT, elle doit
            // prendre effet a la date d'emission de ce brouillon : une decision
            // datee ailleurs decrit une autre operation et est refusee a la
            // liaison.
            'effectiveAt' => $effectiveAt ?? gmdate('Y-m-d'),
            'currency' => 'eur',
            'priceMode' => 'tax_exclusive',
            'lines' => $lines,
        ], $this->idem->key($keySuffix));

        if (($decision['status'] ?? null) !== 'final' || ($decision['amountToCharge'] ?? null) === null) {
            return null;
        }

        return $decision;
    }

    /**
     * Restate the operation a commercial draft carries, so the decision covers
     * exactly it — same references, same amounts, no VAT.
     *
     * @param array<string, mixed> $draft
     * @return array<int, array<string, mixed>>
     */
    private function decisionLinesFromDraft(array $draft): array
    {
        $lines = [];
        foreach ($draft['lines'] as $line) {
            $decisionLine = [
                'reference' => $line['reference'],
                'description' => $line['description'],
                'category' => $line['supplyCategory'],
                'rateCategory' => $line['rateCategory'],
                'unitAmount' => $line['unitPrice'],
                'quantity' => $line['quantity'],
            ];
            if (isset($line['discount'])) {
                $decisionLine['discount'] = $line['discount'];
            }
            $lines[] = $decisionLine;
        }

        return $lines;
    }

    /**
     * Render the decided lines on the document: unit and catalogue product
     * only — the VAT comes from the decision.
     *
     * @param array<string, mixed> $draft
     * @return array<int, array<string, mixed>>
     */
    private function presentationFromDraft(array $draft): array
    {
        $lines = [];
        foreach ($draft['lines'] as $line) {
            $presentation = ['taxLineRef' => $line['reference'], 'unit' => $line['unit']];
            if (isset($line['product'])) {
                $presentation['product'] = $line['product'];
            }
            $lines[] = $presentation;
        }

        return $lines;
    }

    /**
     * The main commercial operation (decision lines: no rate is stated —
     * Facturino concludes).
     *
     * @return array<int, array<string, mixed>>
     */
    private function mainOperationLines(): array
    {
        return [
            [
                'reference' => 'conseil-2h',
                'description' => 'Prestation conseil (2h)',
                'category' => 'services',
                'rateCategory' => 'standard',
                'unitAmount' => 12000, // 120,00 EUR HT / heure
                'quantity' => '2',
            ],
            [
                'reference' => 'abo-studio',
                'description' => 'Abonnement Studio — 1 mois',
                'category' => 'electronically_supplied_services',
                'rateCategory' => 'standard',
                'unitAmount' => 6000,  // 60,00 EUR HT
                'quantity' => '1',
            ],
        ];
    }

    /**
     * Assemble the decision-backed invoice payload: the document lines
     * reference the decided lines and carry presentation only.
     *
     * @return array<string, mixed>
     */
    private function invoicePayloadFromDecision(string $taxDecisionId): array
    {
        return [
            'customerId' => $this->customerId(),
            'purchaseOrderNumber' => 'PO-2026-0042', // BT-13
            'taxDecisionId' => $taxDecisionId,
            'decisionLines' => [
                ['taxLineRef' => 'conseil-2h', 'unit' => 'hour'],
                ['taxLineRef' => 'abo-studio', 'unit' => 'month'],
            ],
            // BG-7 acheteur : SIRET 14 chiffres requis pour le B2B (CIUS-FR BT-46).
            'buyer' => $this->buyerBlock(),
            'payment' => $this->paymentTerms(),
            'dates' => [
                'issued' => gmdate('Y-m-d'),
                'due' => gmdate('Y-m-d', strtotime('+30 days')),
            ],
        ];
    }

    /**
     * Resout un document async : si la reponse contient deja une URL signee on
     * la renvoie ; sinon on poll le job jusqu'a completion (jobs.retrieve).
     *
     * @param array<string, mixed> $response
     */
    private function resolveDocument(array $response): ?string
    {
        if (isset($response['url']) && is_string($response['url'])) {
            return $response['url'];
        }

        $jobId = $response['id'] ?? ($response['jobId'] ?? null);
        if (!is_string($jobId)) {
            return null;
        }

        // Poll borne : au plus 5 tentatives espacees d'une seconde.
        for ($i = 0; $i < 5; $i++) {
            $job = Job::retrieve($jobId);
            $status = $job['status'] ?? 'pending';
            if ($status === 'completed' || $status === 'succeeded') {
                // The job resource exposes the signed link as `url`.
                return $job['url'] ?? null;
            }
            if ($status === 'failed') {
                return null;
            }
            sleep(1);
        }

        return null;
    }

    private function companyId(): string
    {
        $id = $this->state['companyId'] ?? null;
        if (!is_string($id)) {
            throw new ApiException('companyId indisponible — jouez d\'abord la phase A (bootstrap).');
        }

        return $id;
    }

    /**
     * Buyer block (BG-7) shared by the invoices this scenario issues. A 14-digit
     * SIRET is required for B2B (CIUS-FR BT-46).
     *
     * @return array<string, mixed>
     */
    private function buyerBlock(): array
    {
        return [
            'companyName' => 'Boulangerie Martin SARL',
            'siret' => '73282932000074',
            'vatNumber' => 'FR47732829320',
            'address' => [
                'line1' => '12 rue du Four',
                'postalCode' => '69002',
                'city' => 'Lyon',
                'country' => 'FR',
            ],
        ];
    }

    /**
     * Payment terms shared by the invoices this scenario issues (BT-20, and the
     * late-payment rate plus recovery fee required by Code de commerce L441-10).
     *
     * @return array<string, mixed>
     */
    private function paymentTerms(): array
    {
        return [
            'terms' => 'Paiement a 30 jours',
            'termsDays' => 30,
            'method' => 'transfer',
            'latePaymentRate' => '10.00',
            'collectionFee' => '40.00',
        ];
    }

    private function customerId(): string
    {
        $id = $this->state['customerId'] ?? null;
        if (!is_string($id)) {
            throw new ApiException('customerId indisponible — jouez d\'abord la phase B.');
        }

        return $id;
    }

    private function invoiceId(): string
    {
        $id = $this->state['invoiceId'] ?? null;
        if (!is_string($id)) {
            throw new ApiException('invoiceId indisponible — jouez d\'abord la phase D.');
        }

        return $id;
    }
}
