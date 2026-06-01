<?php

declare(strict_types=1);

namespace AtelierDupont;

use Facturino\Account;
use Facturino\ApiKey;
use Facturino\Billing;
use Facturino\Cabinet;
use Facturino\Company;
use Facturino\CreditNote;
use Facturino\Customer;
use Facturino\Ereporting;
use Facturino\Event;
use Facturino\Exception\ApiException;
use Facturino\Export;
use Facturino\Invoice;
use Facturino\Job;
use Facturino\Member;
use Facturino\Notification;
use Facturino\Payment;
use Facturino\Product;
use Facturino\Quote;
use Facturino\ReceivedInvoice;
use Facturino\RecurringInvoice;
use Facturino\Reference;
use Facturino\Reporting;
use Facturino\Sandbox;
use Facturino\Setting;
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
 *
 * Les operations destructrices / sensibles (suppression de compte, checkout
 * Stripe reel, revocation de membre/cle) sont CODEES mais placees derriere un
 * garde explicite ($allowDestructive) afin de ne jamais abimer un vrai compte.
 */
final class Scenario
{
    private Console $log;
    private Idempotency $idem;
    private Config $config;
    private bool $allowDestructive;

    /**
     * Etat partage entre phases (ids decouverts ou crees au fil du parcours).
     *
     * @var array<string, mixed>
     */
    private array $state = [];

    public function __construct(Config $config, ?string $runId = null, bool $allowDestructive = false)
    {
        $this->config = $config;
        $this->log = new Console();
        $this->idem = new Idempotency($runId);
        $this->allowDestructive = $allowDestructive;
    }

    public function log(): Console
    {
        return $this->log;
    }

    /**
     * Joue l'integralite du parcours A -> J dans l'ordre.
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
            'allow_destructive' => $this->allowDestructive,
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

        // A2b — Reglage de la facturation (regime TVA, format de numerotation).
        $this->step('A2b', 'companies.updateInvoicingSettings — regime TVA & numerotation', function (): array {
            $company = Company::updateInvoicingSettings($this->companyId(), [
                'numberingFormat' => 'FAC-{YYYY}-{seq:5}',
                'defaultPaymentTermsDays' => 30,
                'vatRegime' => 'normal',
            ]);

            return ['companyId' => $company['id'] ?? $this->companyId()];
        });

        // A2c — Parametres comptables (mapping FEC) + relances automatiques.
        $this->step('A2c', 'settings.retrieve/update Accounting + Reminders', function (): array {
            Setting::retrieveAccounting($this->companyId());
            $accounting = Setting::updateAccounting($this->companyId(), [
                'salesAccount' => '707000',
                'vatAccount' => '445710',
            ]);

            Setting::retrieveReminders($this->companyId());
            Setting::updateReminders($this->companyId(), [
                'enabled' => true,
                'schedule' => [7, 15, 30], // J+7 / J+15 / J+30
            ]);

            return ['accountingUpdated' => isset($accounting)];
        });

        // A3 — Connexion PA (BYOPA) : le client fournit ses propres credentials.
        // En mode test, on utilise le connecteur mock pour rendre la demo
        // deterministe (les vrais credentials d'une PA ne sont pas requis).
        $this->step('A3', 'companies.connectPA + testPAConnection (BYOPA)', function (): array {
            Company::connectPA($this->companyId(), [
                'provider' => 'mock',
                'apiKey' => 'demo-pa-key',
            ]);
            $test = Company::testPAConnection($this->companyId());

            return ['paConnected' => true, 'reachable' => $test['ok'] ?? ($test['status'] ?? null)];
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
                'unitPrice' => 9900,  // 99,00 EUR HT
                'vatRate' => 2000,    // 20,00 %
                'unit' => 'mois',
            ], $this->idem->key('B5-subscription'));
            $this->state['productSubscriptionId'] = $product['id'];

            return ['productId' => $product['id'], 'name' => $product['name'] ?? null];
        });

        $this->step('B5b', 'products.create — prestation a l\'unite', function (): array {
            $product = Product::create([
                'name' => 'Prestation conseil',
                'description' => 'Accompagnement projet, facture a l\'heure',
                'unitPrice' => 12000, // 120,00 EUR HT
                'vatRate' => 2000,
                'unit' => 'heure',
            ], $this->idem->key('B5-consulting'));
            $this->state['productConsultingId'] = $product['id'];

            return ['productId' => $product['id']];
        });

        // B5c — Lecture / mise a jour / liste (pagination par curseur).
        $this->step('B5c', 'products.get / update / list', function (): array {
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

            return ['productsSeen' => $count];
        });

        // B5d — Import / export CSV (jobs asynchrones).
        $this->step('B5d', 'products.importCsv / exportCsv', function (): array {
            Product::importCsv([
                'rows' => [
                    ['name' => 'Forfait setup', 'unitPrice' => 30000, 'vatRate' => 2000, 'unit' => 'forfait'],
                ],
            ]);
            $export = Product::exportCsv();

            return ['exportJob' => $export['id'] ?? ($export['jobId'] ?? null)];
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
            Customer::importCsv([
                'rows' => [
                    [
                        'name' => 'Cabinet Durand',
                        'type' => 'company',
                        'email' => 'contact@durand.test',
                        'siret' => '40483304800010',
                    ],
                ],
            ]);
            $export = Customer::exportCsv();

            return ['exportJob' => $export['id'] ?? ($export['jobId'] ?? null)];
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
                'customer' => $this->customerId(),
                'items' => [
                    [
                        'description' => 'Mise en place studio + 2h conseil',
                        'quantity' => 1,
                        'unitPrice' => 30000, // 300,00 EUR HT
                        'vatRate' => 2000,
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

        $this->step('C7d', 'quotes.convert — devis accepte -> facture brouillon', function (): array {
            $invoice = Quote::convert($this->state['quoteId']);
            // La facture issue de la conversion sert de base au cycle D.
            $this->state['convertedInvoiceId'] = $invoice['id'] ?? null;

            return ['invoiceId' => $invoice['id'] ?? null, 'status' => $invoice['status'] ?? null];
        });

        // C8 — Validation amont EN16931 sans rien emettre.
        $this->step('C8', 'validate.run — controle EN16931 du payload', function (): array {
            $validation = Validate::run([
                'kind' => 'invoice',
                'invoice' => $this->invoicePayload(),
            ]);

            return [
                'valid' => $validation['valid'] ?? ($validation['ok'] ?? null),
                'issues' => count($validation['errors'] ?? ($validation['issues'] ?? [])),
            ];
        });
    }

    // -----------------------------------------------------------------
    // D. Cycle de vie facture
    // -----------------------------------------------------------------

    public function invoiceLifecycle(): void
    {
        // D9 — Creer une facture (buyer BG-7, lignes, payment, BT-13).
        $this->step('D9', 'invoices.create — brouillon complet', function (): array {
            $invoice = Invoice::create($this->invoicePayload(), $this->idem->key('D9-invoice'));
            $this->state['invoiceId'] = $invoice['id'];

            return ['invoiceId' => $invoice['id'], 'status' => $invoice['status'] ?? null];
        });

        // D9b — Finaliser (numerotation atomique, irreversible).
        $this->step('D9b', 'invoices.finalize / get / getStatus', function (): array {
            $id = $this->invoiceId();
            $finalized = Invoice::finalize($id);
            Invoice::retrieve($id);
            $status = Invoice::getStatus($id);

            return [
                'number' => $finalized['number'] ?? null,
                'status' => $status['status'] ?? ($finalized['status'] ?? null),
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

    public function recurring(): void
    {
        $this->step('E16', 'recurringInvoices.create — abonnement mensuel', function (): array {
            $recurring = RecurringInvoice::create([
                'customer' => $this->customerId(),
                'frequency' => 'monthly',
                'startDate' => gmdate('Y-m-d'),
                'items' => [
                    [
                        'description' => 'Abonnement Atelier Dupont — Studio',
                        'quantity' => 1,
                        'unitPrice' => 9900, // 99,00 EUR HT
                        'vatRate' => 2000,
                    ],
                ],
            ], $this->idem->key('E16-recurring'));
            $this->state['recurringId'] = $recurring['id'];

            return ['recurringId' => $recurring['id'], 'frequency' => 'monthly'];
        });

        $this->step('E16b', 'recurringInvoices.get / update / list', function (): array {
            $id = $this->state['recurringId'];
            RecurringInvoice::retrieve($id);
            RecurringInvoice::update($id, ['dayOfMonth' => 1]);

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
            $credit = CreditNote::create([
                'customer' => $this->customerId(),
                'invoice' => $this->invoiceId(), // avoir rattache a la facture emise
                'reason' => 'Remise commerciale exceptionnelle',
                'items' => [
                    [
                        'description' => 'Avoir partiel — prestation conseil',
                        'quantity' => 1,
                        'unitPrice' => 5000, // 50,00 EUR HT
                        'vatRate' => 2000,
                    ],
                ],
            ], $this->idem->key('F17-credit'));
            $this->state['creditNoteId'] = $credit['id'];

            return ['creditNoteId' => $credit['id'], 'status' => $credit['status'] ?? null];
        });

        $this->step('F17b', 'creditNotes.finalize / send / getPdf / getFacturx', function (): array {
            $id = $this->state['creditNoteId'];
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
    }

    // -----------------------------------------------------------------
    // G. Achats (factures recues)
    // -----------------------------------------------------------------

    public function purchases(): void
    {
        $this->step('G18', 'invoices.createIncoming / listIncoming', function (): array {
            $incoming = Invoice::createIncoming([
                'supplier' => [
                    'name' => 'Fournitures Pro SAS',
                    'siret' => '49759781400025',
                ],
                'number' => 'F-EXT-2026-512',
                'currency' => 'EUR',
                'totalExclVat' => 20000, // 200,00 EUR HT
                'totalVat' => 4000,      // 40,00 EUR TVA
                'totalInclVat' => 24000, // 240,00 EUR TTC
                'dates' => [
                    'issued' => gmdate('Y-m-d'),
                    'due' => gmdate('Y-m-d', strtotime('+30 days')),
                ],
            ], $this->idem->key('G18-incoming'));
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

        $this->step('I23', 'exports.generateFec / getFecStatus / exportInvoices / exportRgpd', function () use ($periodStart, $periodEnd): array {
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

            $invoicesExport = Export::exportInvoices();
            $rgpd = Export::exportRgpd();
            $rgpdId = $rgpd['id'] ?? ($rgpd['jobId'] ?? null);
            if (is_string($rgpdId)) {
                Export::getExportStatus($rgpdId);
            }

            return [
                'fec' => $fec,
                'invoicesExportJob' => $invoicesExport['id'] ?? ($invoicesExport['jobId'] ?? null),
            ];
        });

        $this->step('I24', 'ereporting.create / list / get / submit', function (): array {
            $declaration = null;
            try {
                $declaration = Ereporting::createDeclaration([
                    'type' => 'b2c',
                    'periodStart' => gmdate('Y-m-01'),
                    'periodEnd' => gmdate('Y-m-t'),
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

        $this->step('I26', 'notifications.list / markRead / markAllRead / preferences', function (): array {
            $notifications = Notification::all(['limit' => 5]);
            $first = $notifications->getData()[0] ?? null;
            if ($first !== null) {
                Notification::markRead($first['id']);
            }
            Notification::markAllRead();
            Notification::retrievePreferences();
            Notification::updatePreferences([
                'invoice.paid' => ['email' => true, 'inApp' => true],
            ]);

            return ['notificationsSeen' => count($notifications)];
        });
    }

    // -----------------------------------------------------------------
    // J. Administration du compte
    // -----------------------------------------------------------------

    public function administration(): void
    {
        // J27 — Cles API : creer une cle a scope restreint pour un worker.
        $this->step('J27', 'apiKeys.create / list / get / roll (+ revoke garde)', function (): array {
            $key = ApiKey::create([
                'name' => 'worker-readonly',
                'permissions' => ['invoices:read', 'customers:read'],
            ], $this->idem->key('J27-key'));
            $keyId = $key['id'] ?? null;
            $this->state['workerKeyId'] = $keyId;

            if (is_string($keyId)) {
                ApiKey::retrieve($keyId);
                ApiKey::roll($keyId); // rotation du secret, meme id
            }

            $count = 0;
            foreach (ApiKey::all(['limit' => 25]) as $_k) {
                $count++;
            }

            // revoke est destructif (revocation immediate) : derriere garde.
            if ($this->allowDestructive && is_string($keyId)) {
                ApiKey::revoke($keyId);
            }

            return [
                'keyId' => $keyId,
                'keysSeen' => $count,
                'revoked' => $this->allowDestructive,
            ];
        });

        // J28 — Membres : inviter, lister, role ; revoke derriere garde.
        $this->step('J28', 'members.invite / list / get / updateRole / resendInvitation (+ revoke garde)', function (): array {
            $member = Member::invite($this->companyId(), [
                'email' => 'comptable@atelier-dupont.test',
                'role' => 'accountant',
                'displayName' => 'Comptable externe',
            ], $this->idem->key('J28-member'));
            $memberId = $member['id'] ?? null;

            if (is_string($memberId)) {
                Member::retrieve($this->companyId(), $memberId);
                Member::updateRole($this->companyId(), $memberId, ['role' => 'admin']);
                Member::resendInvitation($this->companyId(), $memberId);
            }

            $count = 0;
            foreach (Member::all($this->companyId(), ['limit' => 25]) as $_m) {
                $count++;
            }

            if ($this->allowDestructive && is_string($memberId)) {
                Member::revoke($this->companyId(), $memberId);
            }

            return ['memberId' => $memberId, 'membersSeen' => $count, 'revoked' => $this->allowDestructive];
        });

        // J29 — Facturation Facturino (abonnement de la plateforme).
        $this->step('J29', 'billing.retrieveSubscription / listInvoices / getInvoicePdf', function (): array {
            $subscription = Billing::retrieveSubscription();

            $invoices = Billing::listInvoices(['limit' => 5]);
            $first = $invoices->getData()[0] ?? null;
            if ($first !== null && isset($first['id'])) {
                Billing::getInvoicePdf($first['id']);
            }

            // updateSubscription / checkout / portal / pause / resume sont des
            // mutations de l'abonnement reel -> derriere garde explicite.
            if ($this->allowDestructive) {
                Billing::updateSubscription(['plan' => 'pro', 'cycle' => 'monthly']);
                Billing::portal(['returnUrl' => $this->config->publicBaseUrl . '/billing']);
                // Billing::checkout([...]) demarre un paiement reel : laisse en commentaire.
                // Billing::pause(['months' => 1]); Billing::resume();
            }

            return [
                'plan' => $subscription['plan'] ?? null,
                'status' => $subscription['status'] ?? null,
                'platformInvoices' => count($invoices),
            ];
        });

        // J30 — RGPD : export des donnees + preferences de notification compte.
        $this->step('J30', 'account.requestExport / downloadExport / updateNotifications', function (): array {
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

            Account::updateNotifications([
                'productUpdates' => false,
                'billingAlerts' => true,
            ]);

            // scheduleDeletion / cancelDeletion planifieraient la suppression du
            // compte (RGPD art. 17). On ne les declenche JAMAIS automatiquement :
            // ils restent ici a titre documentaire, derriere garde.
            if ($this->allowDestructive) {
                Account::scheduleDeletion();
                Account::cancelDeletion(); // annulation immediate dans la foulee
            }

            return ['exportId' => $exportId, 'downloadReady' => $downloadUrl !== null];
        });

        // Cabinets : surface experts-comptables, hors coeur SaaS. Appel
        // illustratif minimal (necessite un plan cabinet_*).
        $this->step('J-cabinets', 'cabinets.list — illustratif (plan cabinet_* requis)', function (): array {
            try {
                $cabinets = Cabinet::all(['limit' => 1]);

                return ['cabinetsSeen' => count($cabinets)];
            } catch (ApiException $e) {
                return ['cabinets' => 'skip: ' . $e->getMessage()];
            }
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
    private function invoicePayload(): array
    {
        return [
            'customer' => $this->customerId(),
            'purchaseOrderNumber' => 'PO-2026-0042', // BT-13
            'items' => [
                [
                    'description' => 'Prestation conseil (2h)',
                    'quantity' => 2,
                    'unitPrice' => 12000, // 120,00 EUR HT / heure
                    'vatRate' => 2000,    // 20,00 %
                ],
                [
                    'description' => 'Abonnement Studio — 1 mois',
                    'quantity' => 1,
                    'unitPrice' => 6000,  // 60,00 EUR HT
                    'vatRate' => 2000,
                ],
            ],
            'delivery' => [ // BG-7 adresse de livraison
                'address' => [
                    'line1' => '12 rue du Four',
                    'postalCode' => '69002',
                    'city' => 'Lyon',
                    'country' => 'FR',
                ],
            ],
            'payment' => [
                'method' => 'transfer',
                'termsDays' => 30,
            ],
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
                return $job['download_url'] ?? ($job['url'] ?? null);
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
