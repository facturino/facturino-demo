# Scénario commun — "Atelier Dupont" (mini-SaaS B2B)

Les cinq démos implémentent **le même parcours**, dans cinq stacks différentes.
Le but : montrer comment un SaaS B2B français pilote **100 % de sa facturation
via Facturino**, du premier client jusqu'à la comptabilité.

Personae : *Atelier Dupont SAS*, un studio qui vend des prestations et un
abonnement mensuel à ses clients pros. Il encaisse via Facturino, dépose ses
factures à la PA (réforme e-invoicing française), et exporte sa compta.

Chaque démo est une petite application backend exécutable : un serveur HTTP
expose des routes qui déclenchent les étapes, plus un endpoint public qui reçoit
les webhooks Facturino. Aucune UI lourde — la valeur est dans l'usage de l'API.

---

## Le parcours (ordre d'exécution)

> Chaque étape cite les opérations Facturino utilisées. La numérotation des
> familles sert à vérifier que **l'union des étapes couvre toutes les familles
> d'API** (voir « Couverture » en bas).

### A. Bootstrap du compte SaaS
1. **Qui suis-je** — `account.retrieve` : vérifier la clé, le plan, le livemode.
2. **Société émettrice** — `companies.list` / `companies.get`.
2b. **CGV & onboarding** — `companies.uploadCgv` / `getCgv` / `deleteCgv`
   (conditions générales de vente, PDF encodé en base64) puis
   `companies.addMilestone` (jalon d'onboarding, ex. `firstInvoice`).
3. **Référentiels** — `reference.listLegalForms`, `reference.listNafCodes`.
   (La connexion PA / BYOPA se configure dans l'app web Facturino, pas via
   l'API ; la démo suppose une PA déjà connectée, ou force les transitions de
   statut PA en mode test avec `sandbox.simulateStatus`.)
4. **Quotas** — `usage.retrieve` : afficher consommation vs limites du plan.

### B. Catalogue & client
5. **Produits** — `products.create` (abonnement mensuel + prestation à l'unité),
   `products.list` (dont filtres `q` recherche par nom, `category`, `active`),
   `products.get`, `products.update`. Import/export :
   `products.importCsv` / `products.exportCsv`.
6. **Client** — `customers.lookup` (SIRENE/VIES) puis `customers.create` (avec un
   contact `role: billing` qui reçoit les factures par défaut),
   `customers.get`, `customers.update`, `customers.list`. CSV :
   `customers.importCsv` / `customers.exportCsv`.

### C. Devis → facture
7. **Devis** — `quotes.create`, `quotes.send`, `quotes.get`, `quotes.accept`,
   `quotes.getPdf`, `quotes.getSignatureProof`, `quotes.clone` (re-proposer un
   devis similaire en brouillon), puis `quotes.convert` (→ facture brouillon).
8. **Validation amont** — `validate.run` sur le payload de facture avant
   création (montre la validation EN16931 sans rien émettre).

### D. Cycle de vie facture
9. **Créer / finaliser** — `invoices.create` (buyer BG-7, lignes, payment,
   purchaseOrderNumber BT-13), `invoices.finalize` (numérotation),
   `invoices.get`, `invoices.getStatus`, `invoices.list` (dont filtre
   `convertedFrom` : retrouver les factures issues du devis converti).
10. **Documents** — `invoices.getPdf`, `invoices.getFacturx`, `invoices.getXml`
    (CII + UBL), via `jobs.poll` quand la génération est asynchrone.
11. **Dépôt PA** — `invoices.send` (dépôt à la plateforme).
12. **Encaissement** — `invoices.createPaymentLink` (Stripe),
    `invoices.createPortalLink`, `invoices.createPaymentToken` (jeton de
    paiement signé), puis `payments.create` + `payments.list`.
13. **Relance & retard** — `invoices.remind` ; `invoices.listEvents`.
14. **Piste d'audit** — `invoices.verify` (chaîne de hash),
    `invoices.getAuditTrail`, `invoices.generateAuditTrailPdf`.
15. **Clone** — `invoices.clone` (récurrence manuelle ponctuelle).

### E. Abonnement récurrent (cœur SaaS)
16. **Récurrence** — `recurringInvoices.create` (mensuel),
    `recurringInvoices.list`, `recurringInvoices.get`,
    `recurringInvoices.update`, `recurringInvoices.pause`,
    `recurringInvoices.resume`.

### F. Avoir
17. **Remboursement / correction** — `creditNotes.create` (lié à la facture),
    `creditNotes.finalize`, `creditNotes.send`, `creditNotes.getPdf`,
    `creditNotes.getFacturx`, puis `invoices.get` avec `expand=credit_notes`
    (avoirs liés + solde net de la facture).

### G. Achats (factures reçues)
18. **Entrant** — `invoices.createIncoming` / `invoices.listIncoming` ;
    `receivedInvoices.list`, `receivedInvoices.get`,
    `receivedInvoices.approve` / `refuse` / `suspend`,
    `receivedInvoices.recordPayment`.

### H. Webhooks (asynchrone, temps réel)
19. **Endpoint** — `webhookEndpoints.create` (URL publique du serveur démo +
    events voulus), `webhookEndpoints.list`, `webhookEndpoints.test`.
20. **Réception** — la route `/webhooks` vérifie la **signature** et traite
    `invoice.finalized`, `invoice.transmitted`, `invoice.paid`,
    `quote.accepted`, etc. La démo « sans SDK » vérifie la signature à la main ;
    les démos SDK utilisent le helper `webhooks.*`.
21. **Rejeu** — `events.list`, `events.get`, `events.retry`.

### I. Comptabilité & pilotage
22. **Reporting** — `reporting.vatReport`, `reporting.revenueReport`.
23. **Exports** — `exports.generateFec` + `exports.getFecStatus` (FEC),
    `exports.exportInvoices` + `exports.getExportStatus` (ZIP Factur-X).
    Le portage RGPD au niveau du compte est couvert en J via
    `account.requestExport` / `account.downloadExport`.
24. **E-reporting** — `ereporting.createDeclaration`, `ereporting.list`,
    `ereporting.get`, `ereporting.submitDeclaration`.
25. **Archives** — `archives.list`, `archives.get`.
### J. Compte & facturation (API développeur — lecture seule)
26. **Facturation Facturino** — `billing.retrieveSubscription`,
    `billing.listInvoices`, `billing.getInvoicePdf`. L'API billing est en
    **lecture seule** : le changement de plan, l'annulation et le portail de
    paiement se gèrent dans l'app web Facturino, pas via l'API.
27. **RGPD (portabilité)** — `account.requestExport` + `account.downloadExport`.

### Hors périmètre de l'API développeur (gérés dans l'app web Facturino)
- La **connexion PA (BYOPA)**, le **changement de plan/abonnement**, les **clés
  API**, les **membres/équipe**, les **notifications produit**, la **MFA** et les
  **cabinets** sont des surfaces d'interface (compte, sécurité, équipe) — hors
  API développeur, donc non exercées par cette démo.
- **Sandbox** (`sandbox.simulateStatus`) : en mode `fac_test_`, sert à forcer
  une transition de statut PA pour démontrer la chaîne de webhooks sans
  attendre la vraie PA. Utilisé pour rendre la démo déterministe.

---

## Conventions transverses (toutes les démos)

- **Montants** : entiers en centimes (`10000` = 100,00 €). **TVA** : centièmes
  de pourcent (`2000` = 20,00 %). Jamais de float.
- **Idempotence** : `Idempotency-Key` sur chaque POST de création (régénéré par
  étape, stable en cas de retry).
- **Pagination** : cursor-based (`starting_after`), suivre `has_more`.
- **Erreurs** : format `{ error: { type, code, message, param, doc_url,
  request_id, hint } }`. Les démos affichent `request_id` pour le support.
- **Idempotence métier** : le scénario est rejouable (lookup-or-create sur le
  client, réutilisation d'un brouillon existant).
- **Config** : tout vient de l'environnement — `FACTURINO_API_KEY` (fac_test_),
  `FACTURINO_BASE_URL` (défaut `https://facturino.com/api/v1`),
  `FACTURINO_WEBHOOK_SECRET`, `PORT`. Voir `.env.example`.
- **Déterminisme** : en `fac_test_`, on utilise `sandbox.simulateStatus` pour
  faire avancer les statuts PA, sinon la démo attendrait un dépôt réel.

---

## Couverture des familles d'API

Le parcours ci-dessus touche chaque famille au moins une fois :

account · archives · billing · companies · creditNotes · customers ·
ereporting · events · exports · invoices · jobs · payments · products ·
quotes · receivedInvoices · recurringInvoices · reference · reporting ·
sandbox · usage · validate · webhookEndpoints · webhooks(réception)

Chaque démo inclut, à la fin de son README, une **table de correspondance
étape → méthode SDK (ou requête HTTP pour la démo sans SDK)**.
