"""The Atelier Dupont scenario — the full A->J Facturino journey.

Each phase is a standalone function so the HTTP server can expose them
individually (``POST /run/<phase>``) or chain them all (``POST /run``).
Every step cites the SDK method it calls; the README ships the exhaustive
step -> method table.

Conventions enforced throughout (see docs/SCENARIO.md):
  * amounts are integer centimes (10000 = 100.00 EUR);
  * VAT rates are centipercent (2000 = 20.00 %);
  * POST creations carry a stable Idempotency-Key so the run is replayable;
  * list endpoints use cursor pagination (the SDK auto-follows ``has_more``).
"""

from __future__ import annotations

import base64
import os
import secrets
from typing import Any, Optional

import facturino
from facturino import ApiError, NotFoundError, PermissionDeniedError, PlanLimitError

from .helpers import (
    extract_job_id,
    first,
    idempotency_key,
    poll_job,
    run_step,
)

# A run id namespaces the idempotency keys for this scenario execution. A fresh
# id per run keeps each execution self-contained: re-running creates a new set
# of resources instead of colliding with a previous run's lifecycle state (e.g.
# an already-converted quote that can no longer be sent). Pin DEMO_RUN_ID to
# replay a specific run's idempotency keys.
RUN_ID = os.environ.get("DEMO_RUN_ID") or secrets.token_hex(4)

# Fixed demo dates and party details, so a run is reproducible and its payloads
# are readable in the docs.
ISSUED_ON = "2026-06-29"
DUE_ON = "2026-07-29"
MID_TERM_ON = "2026-07-14"
BUYER = {
    "companyName": "Menuiserie Lemoine SARL",
    "siret": "55208131766522",
    "vatNumber": "FR40552081317",
    "address": {"line1": "12 rue des Artisans", "postalCode": "69007", "city": "Lyon", "country": "FR"},
}
PAYMENT_TERMS = {
    "terms": "Paiement a 30 jours",
    "termsDays": 30,
    "method": "transfer",
    "latePaymentRate": "10.00",
    "collectionFee": "40.00",
}


# --------------------------------------------------------------------------- #
# Small SDK-call wrapper for the resource helpers that do not yet expose the
# demo's stable idempotency key as an argument.
# --------------------------------------------------------------------------- #


def _post_with_key(client: facturino.Client, path: str, body: dict[str, Any], key: str) -> dict[str, Any]:
    """POST through the shared transport when a resource helper has no key argument."""
    resp = client._http.post(path, json=body, idempotency_key=key)
    return resp.json()


def _decide(
    client: facturino.Client,
    log: list[dict[str, Any]],
    customer_id: str,
    lines: list[dict[str, Any]],
    key_suffix: str,
    label: str,
    effective_at: str = ISSUED_ON,
) -> Optional[dict[str, Any]]:
    """Take a `facturino`-source decision on the given commercial lines.

    Returns None — after logging what is missing — unless the decision is
    final: `pending_verification` means "cannot conclude yet", never "0".

    `effective_at` is the date the operation takes effect. When the decision
    fiscalises an EXISTING draft it must be that draft's issue date: a decision
    dated elsewhere describes another operation and is refused at binding.
    """
    decision = run_step(
        label,
        lambda: client.tax_decisions.create(
            tax_source="facturino",
            customer_id=customer_id,
            effective_at=effective_at,
            currency="eur",
            price_mode="tax_exclusive",
            lines=lines,
            idempotency_key=idempotency_key(key_suffix, RUN_ID),
        ),
        log,
    )
    if decision["status"] != "final" or decision.get("amountToCharge") is None:
        for issue in decision.get("issues", []):
            log.append({"step": f"{label} — decision incomplete", "ok": False, "detail": issue})
        return None
    return decision


# --------------------------------------------------------------------------- #
# Phase A — Bootstrap the SaaS account
# --------------------------------------------------------------------------- #


def phase_a_bootstrap(client: facturino.Client, log: list[dict[str, Any]]) -> dict[str, Any]:
    """A. Who am I, emitting company, settings, quotas."""
    state: dict[str, Any] = {}

    # A1 — account.retrieve: verify key, plan, livemode.
    account = run_step("A1 account.retrieve", client.account.retrieve, log)
    state["plan"] = account.get("plan")
    state["livemode"] = account.get("livemode")

    # A2 — companies.list / get: resolve the emitting company.
    companies = run_step("A2 companies.list", client.companies.list, log)
    company = first(companies)
    if company is None:
        # No company yet: create one (rare on a provisioned test account).
        company = run_step(
            "A2 companies.create",
            lambda: _post_with_key(
                client,
                "/v1/companies",
                {"name": "Atelier Dupont SAS", "siret": "39204939000019", "legalForm": {"code": "5710"}},
                idempotency_key("create-company", RUN_ID),
            ),
            log,
        )
    company_id = company["id"]
    state["company_id"] = company_id
    run_step("A2 companies.get", lambda: client.companies.get(company_id), log)

    # A2b — Company admin: general terms (CGV) round-trip + onboarding milestone.
    def _company_admin() -> dict[str, Any]:
        cgv = base64.b64encode(b"%PDF-1.4\n% Conditions generales de vente (demo)\n").decode()
        client.companies.upload_cgv(company_id, cgv)
        client.companies.get_cgv(company_id)
        client.companies.delete_cgv(company_id)
        return client.companies.add_milestone(company_id, "firstInvoice")

    _optional(log, "A2b companies CGV upload/get/delete + add_milestone", _company_admin)

    # Company settings (numbering, accounting, reminders) are configured in the
    # Facturino app console — the API consumes them but does not manage them.

    # A3 — reference tables used to power company / customer forms.
    _optional(log, "A3 reference.list_legal_forms", lambda: first(client.reference.list_legal_forms(search="SAS")))
    _optional(log, "A3 reference.list_naf_codes", lambda: first(client.reference.list_naf_codes(search="conseil")))

    # A4 — usage: consumption vs plan limits.
    _optional(log, "A4 usage.retrieve", client.usage.retrieve)

    return state


# --------------------------------------------------------------------------- #
# Phase B — Catalogue & customer
# --------------------------------------------------------------------------- #


def phase_b_catalog(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """B. Products (subscription + one-off) and the first B2B customer."""
    # B5 — products.create: a monthly subscription and a per-unit service.
    subscription = run_step(
        "B5 products.create (subscription)",
        lambda: _post_with_key(
            client,
            "/v1/products",
            {
                "name": "Abonnement maintenance mensuel",
                "unitPrice": 9900,  # 99.00 EUR
                "vatRate": 2000,
                "vatCode": "S",
                "unit": "month",
                "reference": "SUB-MAINT",
            },
            idempotency_key("product-subscription", RUN_ID),
        ),
        log,
    )
    service = run_step(
        "B5 products.create (service)",
        lambda: _post_with_key(
            client,
            "/v1/products",
            {
                "name": "Prestation atelier (jour)",
                "unitPrice": 60000,  # 600.00 EUR
                "vatRate": 2000,
                "vatCode": "S",
                "unit": "day",
                "reference": "SVC-DAY",
            },
            idempotency_key("product-service", RUN_ID),
        ),
        log,
    )
    state["subscription_product_id"] = subscription["id"]
    state["service_product_id"] = service["id"]

    run_step("B5 products.list", lambda: list(client.products.list(limit=25)), log)
    # B5 — products.list with filters: prefix search (q), category, active.
    # Find the subscription back via a name prefix to show the search filter.
    run_step(
        "B5 products.list (filters q / category / active)",
        lambda: list(client.products.list(q="Abonnement", active=True, limit=25)),
        log,
    )
    run_step("B5 products.get", lambda: client.products.get(service["id"]), log)
    run_step(
        "B5 products.update",
        lambda: client.products.update(service["id"], description="Journee d'atelier sur site"),
        log,
    )

    # B5 — CSV round-trip (async jobs).
    _optional(
        log,
        "B5 products.import_csv",
        lambda: client.products.import_csv(
            "name,unitPrice,vatRate,unit\nForfait diagnostic,15000,2000,unit\n"
        ),
    )
    _optional(log, "B5 products.export_csv", client.products.export_csv)

    # B6 — customers.lookup (SIRENE/VIES) then create (lookup-or-create).
    _optional(log, "B6 customers.lookup", lambda: client.customers.lookup(siret="55208131766522"))

    existing = _find_customer_by_email(client, "achats@menuiserie-bernard.fr")
    if existing is not None:
        customer = existing
        log.append({"step": "B6 customers.create (reused existing)", "ok": True})
    else:
        customer = run_step(
            "B6 customers.create",
            lambda: _post_with_key(
                client,
                "/v1/customers",
                {
                    "name": "Menuiserie Bernard SARL",
                    "type": "company",
                    "email": "achats@menuiserie-bernard.fr",
                    "siret": "55208131766522",
                    "vatNumber": "FR40552081317",
                    # A billing contact receives the invoices by default.
                    "contacts": [{"email": "compta@menuiserie-bernard.fr", "role": "billing"}],
                    "address": {
                        "line1": "12 rue des Artisans",
                        "postalCode": "69007",
                        "city": "Lyon",
                        "country": "FR",
                    },
                },
                idempotency_key("create-customer", RUN_ID),
            ),
            log,
        )
    customer_id = customer["id"]
    state["customer_id"] = customer_id

    run_step("B6 customers.get", lambda: client.customers.get(customer_id), log)
    run_step(
        "B6 customers.update",
        lambda: client.customers.update(customer_id, phone="+33478000000"),
        log,
    )
    run_step("B6 customers.list", lambda: list(client.customers.list(limit=25)), log)
    _optional(log, "B6 customers.export_csv", client.customers.export_csv)


# --------------------------------------------------------------------------- #
# Phase C — Quote -> invoice
# --------------------------------------------------------------------------- #


def phase_c_quote(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """C. Quote lifecycle, then upfront EN16931 validation of the invoice payload."""
    customer_id = state["customer_id"]

    quote = run_step(
        "C7 quotes.create",
        lambda: _post_with_key(
            client,
            "/v1/quotes",
            {
                "customerId": customer_id,
                "validityDays": 30,
                "lines": [
                    {"description": "Prestation atelier (3 jours)", "quantity": "3", "unitPrice": 60000, "vatRate": 2000, "vatCode": "S", "unit": "unit"},
                ],
                "notes": "Devis valable 30 jours.",
            },
            idempotency_key("create-quote", RUN_ID),
        ),
        log,
    )
    quote_id = quote["id"]
    state["quote_id"] = quote_id

    run_step("C7 quotes.send", lambda: client.quotes.send(quote_id), log)
    run_step("C7 quotes.get", lambda: client.quotes.get(quote_id), log)
    run_step("C7 quotes.accept", lambda: client.quotes.accept(quote_id), log)
    _optional(log, "C7 quotes.get_pdf", lambda: client.quotes.get_pdf(quote_id))
    _optional(log, "C7 quotes.get_signature_proof", lambda: client.quotes.get_signature_proof(quote_id))

    # C7 — quotes.clone: re-propose a similar quote as a fresh draft (no
    # number assigned). Surface the new id so the operator can follow it up.
    cloned = _optional(log, "C7 quotes.clone", lambda: client.quotes.clone(quote_id))
    if isinstance(cloned, dict) and cloned.get("id"):
        state["cloned_quote_id"] = cloned["id"]
        log.append({"step": f"C7 quotes.clone -> {cloned['id']}", "ok": True})

    converted = run_step("C7 quotes.convert", lambda: client.quotes.convert(quote_id), log)
    # The converted draft is a COMMERCIAL draft: it states the operation and no
    # VAT (taxSource null). Phase D decides that same operation, binds the
    # decision to THIS invoice and finalizes it — one document, no orphan.
    state["converted_invoice_id"] = converted.get("id")
    state["converted_commercial_draft"] = converted.get("commercialDraft")
    # The decision must take effect on the draft's OWN issue date: a decision
    # dated elsewhere describes another operation and is refused at binding.
    state["converted_issued_on"] = (converted.get("dates") or {}).get("issued")

    # C8 — validate.run on a candidate invoice payload (no resource created).
    # Even the dry-run is decision-first: the payload references a decision, so
    # one is taken before anything is validated — and nothing is persisted.
    validate_decision = _decide(
        client, log, customer_id,
        [{
            "reference": "prestation-jour",
            "description": "Prestation atelier (jour)",
            "category": "services",
            "rate_category": "standard",
            "unit_amount": 60000,
            "quantity": "1",
        }],
        "validate-decision",
        "C8 taxDecisions.create (validate dry-run)",
    )
    if validate_decision:
        _optional(
            log,
            "C8 validate.run (invoice)",
            lambda: client.validate.run(
                customerId=customer_id,
                buyer=BUYER,
                taxDecisionId=validate_decision["id"],
                decisionLines=[{"taxLineRef": "prestation-jour", "unit": "unit"}],
                dates={"issued": ISSUED_ON, "due": DUE_ON},
                payment=PAYMENT_TERMS,
            ),
        )


# --------------------------------------------------------------------------- #
# Phase D — Invoice lifecycle
# --------------------------------------------------------------------------- #


def phase_d_invoice(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """D. Create / finalize, documents, PA deposit, payment links, reminders, audit."""
    customer_id = state["customer_id"]

    # D9 — the invoice is the one the QUOTE produced. Its commercial block is
    # read back from the converted draft: the line references are assigned
    # server-side at conversion, and the decision must state exactly the
    # operation the draft carries. The decision is then BOUND to that same
    # invoice — creating a second one would orphan the converted draft.
    converted_id = state.get("converted_invoice_id")
    commercial = state.get("converted_commercial_draft")
    if not converted_id or not commercial or not commercial.get("lines") or not state.get("converted_issued_on"):
        log.append({
            "step": "D9 aborted — the converted draft carries no commercial operation",
            "ok": False,
        })
        return

    decision = _decide(
        client, log, customer_id,
        [
            {
                "reference": line["reference"],
                "description": line["description"],
                "category": line["supplyCategory"],
                "rate_category": line["rateCategory"],
                "unit_amount": line["unitPrice"],
                "quantity": line["quantity"],
                **({"discount": line["discount"]} if line.get("discount") else {}),
            }
            for line in commercial["lines"]
        ],
        "invoice-decision",
        "D9 taxDecisions.create (operation of the converted draft)",
        effective_at=state["converted_issued_on"],
    )
    if decision is None:
        log.append({"step": "D9 aborted — the decision is not final", "ok": False})
        return
    invoice = run_step(
        "D9 invoices.bind_tax_decision (converted quote draft)",
        lambda: client.invoices.bind_tax_decision(
            converted_id,
            idempotency_key=idempotency_key("bind-decision", RUN_ID),
            tax_decision_id=decision["id"],
            decision_lines=[
                {
                    "taxLineRef": line["reference"],
                    "unit": line["unit"],
                    **({"product": line["product"]} if line.get("product") else {}),
                }
                for line in commercial["lines"]
            ],
        ),
        log,
    )
    invoice_id = invoice["id"]
    state["invoice_id"] = invoice_id

    run_step("D9 invoices.get", lambda: client.invoices.get(invoice_id), log)
    finalized = run_step("D9 invoices.finalize", lambda: client.invoices.finalize(invoice_id), log)
    state["invoice_number"] = finalized.get("number")
    run_step("D9 invoices.get_status", lambda: client.invoices.get_status(invoice_id), log)

    # D9 — invoices.list filtered by convertedFrom: retrieve the invoices that
    # originated from the quote converted in phase C (when a quote ran first).
    quote_id = state.get("quote_id")
    if quote_id:
        run_step(
            "D9 invoices.list (convertedFrom)",
            lambda: list(client.invoices.list(convertedFrom=quote_id, limit=25)),
            log,
        )

    # D10 — documents. PDF / Factur-X may be async (202 + jobId): poll it.
    _resolve_document(client, log, "D10 invoices.get_pdf", lambda: client.invoices.get_pdf(invoice_id))
    _resolve_document(client, log, "D10 invoices.get_facturx", lambda: client.invoices.get_facturx(invoice_id))
    _optional(log, "D10 invoices.get_xml (CII)", lambda: client.invoices.get_xml(invoice_id, format="cii"))
    _optional(log, "D10 invoices.get_xml (UBL)", lambda: client.invoices.get_xml(invoice_id, format="ubl"))

    # D11 — PA deposit (202 Accepted; submission is async).
    _optional(log, "D11 invoices.send", lambda: client.invoices.send(invoice_id))

    # In test mode, drive the PA status machine deterministically so the
    # payment / webhook steps have a realistic lifecycle to react to.
    _drive_pa_lifecycle(client, log, invoice_id)

    # D12 — collection. Payment links are Pro+; the manual payment always works.
    # The success/cancel redirect URLs must be public — skip without a tunnel.
    if _public(state):
        _optional(
            log,
            "D12 invoices.create_payment_link",
            lambda: client.invoices.create_payment_link(
                invoice_id,
                success_url=f"{_public(state)}/paid",
                cancel_url=f"{_public(state)}/cancelled",
            ),
        )
    else:
        log.append({
            "step": "D12 invoices.create_payment_link (skipped — set PUBLIC_BASE_URL for public redirect URLs)",
            "ok": True,
        })
    _optional(log, "D12 invoices.create_portal_link", lambda: client.invoices.create_portal_link(invoice_id))
    # Signed payment token for an embedded/headless checkout (Pro+).
    _optional(log, "D12 invoices.create_payment_token", lambda: client.invoices.create_payment_token(invoice_id))

    # D12 — dunning before settlement: a reminder can only be sent while the
    # invoice is still unpaid, so send it before recording the payment.
    _optional(log, "D12 invoices.remind", lambda: client.invoices.remind(invoice_id))

    total = _invoice_total(finalized)
    run_step(
        "D12 payments.create",
        lambda: _post_with_key(
            client,
            f"/v1/invoices/{invoice_id}/payments",
            {"amount": total, "method": "transfer", "reference": "VIR-2026-0042", "paidAt": "2026-06-29"},
            idempotency_key("record-payment", RUN_ID),
        ),
        log,
    )
    run_step("D12 payments.list", lambda: list(client.payments.list(invoice_id)), log)

    # D13 — event history.
    run_step("D13 invoices.list_events", lambda: client.invoices.list_events(invoice_id), log)

    # D14 — audit trail (hash chain + PDF).
    _optional(log, "D14 invoices.verify", lambda: client.invoices.verify(invoice_id))
    _optional(log, "D14 invoices.get_audit_trail", lambda: client.invoices.get_audit_trail(invoice_id))
    _optional(
        log,
        "D14 invoices.generate_audit_trail_pdf",
        lambda: client.invoices.generate_audit_trail_pdf(invoice_id),
    )

    # D15 — clone (a one-off manual recurrence).
    _optional(log, "D15 invoices.clone", lambda: client.invoices.clone(invoice_id))


# --------------------------------------------------------------------------- #
# Phase E — Recurring subscription (SaaS core)
# --------------------------------------------------------------------------- #


def phase_e_recurring(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """E. The monthly subscription schedule that powers a SaaS."""
    customer_id = state["customer_id"]

    recurring = run_step(
        "E16 recurring_invoices.create",
        lambda: _post_with_key(
            client,
            "/v1/recurring-invoices",
            {
                "customerId": customer_id,
                "frequency": "monthly",
                "startDate": "2026-06-01",
                "nextGenerationDate": "2026-07-01",
                "autoFinalize": True,
                "autoSend": True,
                # `taxInputs` carries the operation and its fiscal source; each
                # occurrence is decided on its own generation date.
                "taxInputs": {
                    "taxSource": "facturino",
                    "priceMode": "tax_exclusive",
                    "lines": [{
                        "reference": "abo-maint",
                        "description": "Abonnement maintenance mensuel",
                        "category": "electronically_supplied_services",
                        "rateCategory": "standard",
                        "unitAmount": 9900,
                        "quantity": "1",
                        "unit": "unit",
                    }],
                },
                # Presentation and terms only — never a line, never a rate.
                "templateInvoice": {
                    "paymentMethod": "transfer",
                    "paymentTermsDays": 30,
                },
            },
            idempotency_key("create-recurring", RUN_ID),
        ),
        log,
    )
    recurring_id = recurring["id"]
    state["recurring_id"] = recurring_id

    run_step("E16 recurring_invoices.list", lambda: list(client.recurring_invoices.list(limit=25)), log)
    run_step("E16 recurring_invoices.get", lambda: client.recurring_invoices.get(recurring_id), log)
    run_step(
        "E16 recurring_invoices.update",
        lambda: client.recurring_invoices.update(recurring_id, autoSend=False),
        log,
    )
    run_step("E16 recurring_invoices.pause", lambda: client.recurring_invoices.pause(recurring_id), log)
    run_step("E16 recurring_invoices.resume", lambda: client.recurring_invoices.resume(recurring_id), log)


# --------------------------------------------------------------------------- #
# Phase K — Decision-first billing
# --------------------------------------------------------------------------- #


def phase_k_tax_decision(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """K. Decide, collect the decided amount, verify after settlement, then invoice.

    The order is the point. The VAT and the exact amount to debit come from
    Facturino BEFORE anything is collected, and the decision id travels with the
    settlement so what was received can be checked against what was decided.

    Facturino imposes no payment service provider and no payment method. The
    flow below is provider-neutral: the decision id is carried in the payment
    REFERENCE, which every settlement has — a transfer, a direct debit, a
    cheque, cash, or a PSP capture. Two PSP variants are shown afterwards as
    examples; both are simulated locally, and no PSP is ever contacted.
    """
    customer_id = state["customer_id"]

    # K.2 — Decide BEFORE any payment. The idempotency key is stable for this
    # order, so replaying the phase replays the same decision.
    decision = run_step(
        "K taxDecisions.create",
        lambda: client.tax_decisions.create(
            # Facturino determines the VAT; `tax_source="integration"` is the
            # other journey, shown in phase_k_integration below.
            tax_source="facturino",
            customer_id=customer_id,
            # The effective date drives the applicable rules — not the wall clock.
            effective_at=ISSUED_ON,
            currency="eur",
            price_mode="tax_exclusive",
            lines=[{
                "reference": "abo-pro",
                "description": "Abonnement maintenance mensuel",
                # A subscription delivered online is an electronically supplied
                # service: it carries its own place-of-supply rules.
                "category": "electronically_supplied_services",
                "rate_category": "standard",
                "unit_amount": 9900,  # integer cents
                "quantity": "1",      # decimal STRING, never a float
            }],
            idempotency_key=idempotency_key("tax-decision", RUN_ID),
        ),
        log,
    )

    # K.3 — Stop immediately unless the decision is final. "pending_verification"
    # does not mean "nothing to charge": the amounts are None, not 0.
    if decision["status"] != "final" or decision.get("amountToCharge") is None:
        for issue in decision.get("issues", []):
            log.append({"step": "K decision incomplete", "ok": False, "detail": issue})
        return

    # K.4 — Charge exactly what was decided, in the decided currency.
    amount_to_charge = decision["amountToCharge"]
    currency = decision["currency"]

    # K.5 — Carry the decision id with the settlement, whatever the means.
    # Every settlement has a reference: a transfer wording, a direct-debit
    # mandate reference, a cheque number, a PSP charge id. That reference is
    # what lets step K.7 verify what was actually received.
    settlement = {
        "amount": amount_to_charge,
        "currency": currency,
        # transfer, card, check, cash, direct_debit, sepa, paypal or other
        "method": "transfer",
        "reference": decision["id"],
        "paid_at": ISSUED_ON,
    }
    log.append({"step": "K settlement (simulated)", "ok": True, "detail": settlement})

    # K.5b — OPTIONAL, for a PSP-collected payment. Two examples, nothing more:
    # Facturino requires neither. Simulated locally — no call is made.
    log.append({
        "step": "K psp variants (optional, simulated)",
        "ok": True,
        "detail": {
            "stripe_metadata": {"facturino_tax_decision_id": decision["id"]},
            "paypal_custom_id": decision["id"],
            # PayPal reasons in decimal units, so convert from cents.
            "paypal_value": f"{amount_to_charge / 100:.2f}",
        },
    })

    # K.6 — Once settled, read the decision back from the reference carried
    # with the payment.
    source = run_step(
        "K taxDecisions.retrieve",
        lambda: client.tax_decisions.retrieve(settlement["reference"]),
        log,
    )

    # K.7 — Verify amount, currency and buyer against the decision.
    if settlement["amount"] != source["amountToCharge"]:
        raise RuntimeError("settled amount differs from the decision")
    if settlement["currency"] != source["currency"]:
        raise RuntimeError("settled currency differs from the decision")
    if customer_id != source["customerId"]:
        raise RuntimeError("settled buyer differs from the decision")

    # K.8 — The invoice is backed by the decision. No VAT is restated: a
    # decision line is referenced, and the document line carries presentation
    # only (unit, catalogue product).
    draft = run_step(
        "K invoices.create (decision-backed)",
        lambda: client.invoices.create(
            customerId=source["customerId"],
            taxDecisionId=source["id"],
            decisionLines=[{"taxLineRef": "abo-pro", "unit": "unit"}],
            buyer=BUYER,
            dates={"issued": ISSUED_ON, "due": DUE_ON},
            payment=PAYMENT_TERMS,
            idempotency_key=idempotency_key("tax-decision-invoice", RUN_ID),
        ),
        log,
    )

    # K.9 — Finalize: the number is assigned and the content is fixed.
    invoice = run_step(
        "K invoices.finalize",
        lambda: client.invoices.finalize(draft["id"]),
        log,
    )
    state["tax_decision_id"] = source["id"]
    state["decided_invoice_id"] = invoice["id"]

    # K.10 — Send to the platform ONLY on the channel the decision states.
    if source.get("invoiceChannel") == "einvoicing":
        run_step("K invoices.send", lambda: client.invoices.send(invoice["id"]), log)
    else:
        # Not a failure: the operation is simply outside the e-invoicing
        # channel. Calling invoices.send here would be refused, and rightly so.
        log.append({
            "step": "K no platform deposit",
            "ok": True,
            "detail": {
                "invoiceChannel": source.get("invoiceChannel"),
                "note": "the obligation, if any, goes through e-reporting",
            },
        })

    # K.11 — Record the REAL collection on the invoice, with its real date, its
    # real method and the reference that carries the decision id. The payment
    # axis moves; the transmission axis does not.
    settled = invoice
    try:
        client.payments.create(
            invoice["id"],
            amount=settlement["amount"],
            method=settlement["method"],
            reference=settlement["reference"],
            paidAt=settlement["paid_at"],
        )
        settled = client.invoices.get(invoice["id"])
        log.append({"step": "K payments.create", "ok": True,
                    "detail": {"paymentStatus": settled.get("paymentStatus")}})
    except Exception as err:  # noqa: BLE001 — the demo reports, it never crashes
        log.append({"step": "K payments.create", "ok": False, "detail": str(err)})

    # K.12 — Keep the reporting axes: they are the obligations, and they hold
    # whether or not the invoice travelled the network.
    log.append({
        "step": "K reporting axes",
        "ok": True,
        "detail": {
            "transactionReporting": source.get("transactionReporting"),
            "paymentReporting": source.get("paymentReporting"),
            "obligationReasons": source.get("obligationReasons", []),
            "foreignTaxReviewRequired": source.get("foreignTaxReviewRequired"),
            "documentStatus": settled.get("documentStatus"),
            "transmissionStatus": settled.get("transmissionStatus"),
            "paymentStatus": settled.get("paymentStatus"),
        },
    })


def phase_k_decided_credit_note(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """K.12. Credit a DECIDED invoice through `creditedLines`.

    The rate, the category, the VATEX code and the legal mention are inherited
    from the invoice's frozen snapshot — there is no way to restate them.
    """
    invoice_id = state.get("decided_invoice_id")
    if not invoice_id:
        return

    run_step(
        "K creditNotes.create (creditedLines)",
        lambda: client.credit_notes.create(
            relatedInvoiceId=invoice_id,
            creditNoteType="partial",
            reasonCode="quality",
            reason="Partial credit on a decided invoice",
            # Either `quantity` or `amountTTC`, never both. Omitting both
            # credits the line's whole remaining balance.
            creditedLines=[{"taxLineRef": "abo-pro", "amountTTC": 1200}],
            dates={"issued": ISSUED_ON},
            idempotency_key=idempotency_key("decided-credit-note", RUN_ID),
        ),
        log,
    )


def phase_k_decided_recurring(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """K.13. A recurrence on the decided journey.

    `taxInputs` carries the OPERATION, not a decision: a recurrence never stores
    one. Each occurrence is decided on its own effective date, so a schedule
    created today does not carry this quarter's rules into next year.
    """
    run_step(
        "K recurringInvoices.create (taxInputs)",
        lambda: client.recurring_invoices.create(
            customerId=state["customer_id"],
            frequency="monthly",
            startDate=ISSUED_ON,
            nextGenerationDate=DUE_ON,
            taxInputs={
                "taxSource": "facturino",
                "priceMode": "tax_exclusive",
                "lines": [{
                    "reference": "abo-pro",
                    "description": "Abonnement maintenance mensuel",
                    "category": "electronically_supplied_services",
                    "rateCategory": "standard",
                    "unitAmount": 9900,
                    "quantity": "1",
                    "unit": "unit",
                }],
            },
            # `templateInvoice` carries presentation and terms only — never a
            # line, never a rate.
            templateInvoice={"paymentMethod": "transfer", "paymentTermsDays": 30},
            idempotency_key=idempotency_key("decided-recurring", RUN_ID),
        ),
        log,
    )


def phase_k_deposit_and_schedule(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """K.11b. Deposit invoice (386), settled, then deducted from the balance.

    The order matters and is the point: a deposit is deducted as PREPAID
    (BT-113), and an amount is only prepaid once it has actually been collected.
    The deposit is therefore created, finalized, and its payment recorded IN FULL
    before it is attached to the balance invoice. A deposit that is merely
    finalized has been invoiced, not paid.

    The schedule is validated against the amount that remains DUE — the total
    less the prepaid deposit — never against the gross total.
    """
    customer_id = state["customer_id"]

    # A `deposit` line names the principal supply it follows.
    deposit_decision = _decide(
        client, log, customer_id,
        [{
            "reference": "acompte-prestation",
            "description": "Prestation — acompte",
            "category": "deposit",
            "related_category": "services",
            "rate_category": "standard",
            "unit_amount": 24000,
            "quantity": "1",
        }],
        "deposit-decision",
        "K taxDecisions.create (deposit)",
    )
    if deposit_decision is None:
        return
    deposit_draft = run_step(
        "K invoices.create (type=deposit, from the decision)",
        lambda: client.invoices.create(
            idempotency_key=idempotency_key("deposit-draft", RUN_ID),
            customerId=customer_id,
            type="deposit",
            buyer=BUYER,
            tax_decision_id=deposit_decision["id"],
            decision_lines=[{"taxLineRef": "acompte-prestation", "unit": "unit"}],
            dates={"issued": ISSUED_ON, "due": DUE_ON},
            payment=PAYMENT_TERMS,
        ),
        log,
    )
    deposit = run_step("K invoices.finalize (deposit)", lambda: client.invoices.finalize(deposit_draft["id"]), log)

    # Record the payment IN FULL — exactly the decided amount. Until this
    # happens the deposit is not prepaid, and must not be deducted.
    run_step(
        "K payments.create (deposit settled in full)",
        lambda: client.payments.create(
            deposit["id"],
            amount=deposit_decision["amountToCharge"],
            method="transfer",
            paidAt=ISSUED_ON,
        ),
        log,
    )
    settled = run_step("K invoices.get (deposit)", lambda: client.invoices.get(deposit["id"]), log)
    if settled.get("paymentStatus", settled.get("status")) != "paid":
        # Attaching an unsettled deposit would misstate BT-113.
        log.append({
            "step": "K deposit not settled",
            "ok": False,
            "detail": "the deposit is not paid; it is not attached to the balance invoice",
        })
        return

    balance_decision = _decide(
        client, log, customer_id,
        [{
            "reference": "prestation-atelier",
            "description": "Prestation d'atelier",
            "category": "services",
            "rate_category": "standard",
            "unit_amount": 8000,
            "quantity": "10",
        }],
        "balance-decision",
        "K taxDecisions.create (balance)",
    )
    if balance_decision is None:
        return
    # Deposits and schedule settle SERVER-SIDE against the decided amount: the
    # instalments distribute exactly what remains due after the prepaid
    # deposit (BT-113/BT-115), and the last one falls on the due date (BT-9).
    still_due = balance_decision["amountToCharge"] - deposit_decision["amountToCharge"]
    first_instalment = still_due // 2
    balance_draft = run_step(
        "K invoices.create (balance, deposit deducted + schedule)",
        lambda: client.invoices.create(
            idempotency_key=idempotency_key("balance-draft", RUN_ID),
            customerId=customer_id,
            buyer=BUYER,
            tax_decision_id=balance_decision["id"],
            decision_lines=[{"taxLineRef": "prestation-atelier", "unit": "hour"}],
            dates={"issued": ISSUED_ON, "due": DUE_ON},
            payment=PAYMENT_TERMS,
            deposits=[{"invoiceId": deposit["id"]}],
            schedule=[
                {"amount": first_instalment, "dueDate": MID_TERM_ON, "label": "Premier versement"},
                {"amount": still_due - first_instalment, "dueDate": DUE_ON, "label": "Solde"},
            ],
        ),
        log,
    )
    run_step("K invoices.finalize (balance)", lambda: client.invoices.finalize(balance_draft["id"]), log)
    state["deposit_invoice_id"] = deposit["id"]


def phase_k_integration(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """K.14. The OTHER fiscal journey: the VAT is supplied by the integration.

    An ERP or an in-house rules service that already determines the VAT
    declares it on the decision (`tax_source="integration"`). Facturino
    validates the coherence of what is supplied and refuses contradictions
    (`integration_vat_incoherent`) — it never silently corrects a rate. The
    decision, the invoice and the reporting obligations then work exactly as
    on the `facturino` source: the two journeys are equals.
    """
    customer_id = state["customer_id"]

    decision = run_step(
        "K14 taxDecisions.create (integration)",
        lambda: client.tax_decisions.create(
            tax_source="integration",
            customer_id=customer_id,
            effective_at=ISSUED_ON,
            currency="eur",
            price_mode="tax_exclusive",
            lines=[{
                "reference": "conseil-integ",
                "description": "Prestation de conseil (TVA fournie par l'ERP)",
                "category": "services",
                "unit_amount": 10000,
                "quantity": "1",
                "vat_rate": 2000,  # 20.00 % — concluded by YOUR system
                "vat_code": "S",
            }],
            idempotency_key=idempotency_key("integration-decision", RUN_ID),
        ),
        log,
    )
    if decision["status"] != "final" or decision.get("amountToCharge") is None:
        for issue in decision.get("issues", []):
            log.append({"step": "K14 decision incomplete", "ok": False, "detail": issue})
        return

    draft = run_step(
        "K14 invoices.create (from the integration decision)",
        lambda: client.invoices.create(
            idempotency_key=idempotency_key("integration-invoice", RUN_ID),
            customerId=customer_id,
            buyer=BUYER,
            tax_decision_id=decision["id"],
            decision_lines=[{"taxLineRef": "conseil-integ", "unit": "unit"}],
            dates={"issued": ISSUED_ON, "due": DUE_ON},
            payment=PAYMENT_TERMS,
        ),
        log,
    )
    run_step("K14 invoices.finalize", lambda: client.invoices.finalize(draft["id"]), log)

    # A contradiction is refused, never corrected: a positive rate cannot
    # carry an exemption code.
    def _incoherent() -> dict[str, Any]:
        return client.tax_decisions.create(
            tax_source="integration",
            customer_id=customer_id,
            effective_at=ISSUED_ON,
            currency="eur",
            price_mode="tax_exclusive",
            lines=[{
                "reference": "incoherent",
                "description": "Ligne incoherente (demonstration du refus)",
                "category": "services",
                "unit_amount": 10000,
                "quantity": "1",
                "vat_rate": 2000,
                "vat_code": "S",
                "vatex_code": "VATEX-EU-G",
            }],
            idempotency_key=idempotency_key("integration-incoherent", RUN_ID),
        )

    try:
        _incoherent()
        log.append({"step": "K14 incoherent supplied VAT was NOT refused", "ok": False})
    except facturino.FacturinoError as exc:
        log.append({"step": "K14 contradiction refused, never corrected", "ok": True, "detail": str(exc)})


# --------------------------------------------------------------------------- #
# Phase F — Credit note
# --------------------------------------------------------------------------- #


def phase_f_credit_note(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """F. A credit note linked to the finalized invoice (partial refund)."""
    invoice_id = state.get("invoice_id")
    if not invoice_id:
        log.append({"step": "F17 credit_notes.create (skipped, no invoice)", "ok": True})
        return

    # `creditedLines` references the invoice's DECIDED lines: the rate, the
    # category, the VATEX code and the legal mention are inherited from the
    # frozen snapshot, never restated. `amountTTC` credits a fraction.
    credit_note = run_step(
        "F17 credit_notes.create (creditedLines)",
        lambda: client.credit_notes.create(
            idempotency_key=idempotency_key("create-credit-note", RUN_ID),
            relatedInvoiceId=invoice_id,
            creditNoteType="partial",
            reasonCode="quality",
            reason="Geste commercial sur une demi-journee",
            dates={"issued": ISSUED_ON},
            credited_lines=[{"taxLineRef": "prestation-jour", "amountTTC": 36000}],
        ),
        log,
    )
    credit_note_id = credit_note["id"]
    state["credit_note_id"] = credit_note_id

    run_step("F17 credit_notes.finalize", lambda: client.credit_notes.finalize(credit_note_id), log)
    _optional(log, "F17 credit_notes.send", lambda: client.credit_notes.send(credit_note_id))
    _optional(log, "F17 credit_notes.get_pdf", lambda: client.credit_notes.get_pdf(credit_note_id))
    _resolve_document(
        client, log, "F17 credit_notes.get_facturx", lambda: client.credit_notes.get_facturx(credit_note_id)
    )

    # F17 — invoices.get with expand=credit_notes: pull the linked credit
    # notes and the net balance (TTC minus issued credit notes) back onto the
    # source invoice. The expansion lands under invoice["expanded"].
    expanded = _optional(
        log,
        "F17 invoices.get (expand=credit_notes)",
        lambda: client.invoices.get(invoice_id, expand="credit_notes"),
    )
    if isinstance(expanded, dict):
        exp = expanded.get("expanded") or {}
        credit_notes = exp.get("credit_notes")
        net_balance = exp.get("net_balance")
        log.append(
            {
                "step": "F17 invoices.get expanded.credit_notes + net_balance",
                "ok": True,
                "credit_notes": credit_notes,
                "net_balance": net_balance,
            }
        )


# --------------------------------------------------------------------------- #
# Phase G — Purchases (received invoices)
# --------------------------------------------------------------------------- #


def phase_g_received(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """G. Incoming invoices from suppliers: list, approve / refuse / suspend, pay."""
    # G18 — create a supplier invoice (B2B inbound) for the demo to act on.
    incoming = _optional(
        log,
        "G18 invoices.create_incoming",
        lambda: client.invoices.create_incoming(
            senderName="Fournisseur Bois & Co",
            senderSiret="81234567800013",
            amount=54000,  # total incl. VAT, in integer cents
            reference="F-2026-118",
        ),
    )
    _optional(log, "G18 invoices.list_incoming", lambda: list(client.invoices.list_incoming(limit=25)))

    # G18 — the received-invoices surface (PA inbound feed).
    received_page = _optional(log, "G18 received_invoices.list", lambda: list(client.received_invoices.list(limit=25)))
    received = received_page[0] if isinstance(received_page, list) and received_page else None
    if received is None and isinstance(incoming, dict):
        received = incoming
    if isinstance(received, dict) and received.get("id"):
        rid = received["id"]
        _optional(log, "G18 received_invoices.retrieve", lambda: client.received_invoices.retrieve(rid))
        # Approve, then record payment. Refuse/suspend are alternative paths
        # on the same state machine — shown but not run after approval.
        _optional(log, "G18 received_invoices.approve", lambda: client.received_invoices.approve(rid))
        _optional(
            log,
            "G18 received_invoices.record_payment",
            lambda: client.received_invoices.record_payment(rid, amount=45000, method="transfer", paid_at="2026-06-29"),
        )
        log.append(
            {
                "step": "G18 received_invoices.refuse / suspend (alternative paths, not run after approve)",
                "ok": True,
            }
        )
    else:
        log.append({"step": "G18 received_invoices.* (no inbound invoice available)", "ok": True})


# --------------------------------------------------------------------------- #
# Phase H — Webhooks
# --------------------------------------------------------------------------- #


def phase_h_webhooks(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """H. Register the demo's /webhooks endpoint, send a test event, replay events."""
    webhook_url = state.get("webhook_url")

    # Endpoint registration needs a public, DNS-resolvable HTTPS receiver —
    # the API validates the host at creation. Without a tunnel (ngrok,
    # cloudflared) exposed via PUBLIC_BASE_URL, skip the phase gracefully.
    if not webhook_url:
        log.append({
            "step": "H19-H21 webhooks (skipped — set PUBLIC_BASE_URL to a public HTTPS tunnel)",
            "ok": True,
        })
        return

    # H19 — register this server as a webhook endpoint (idempotent on URL).
    existing = _find_endpoint_by_url(client, webhook_url)
    if existing is not None:
        endpoint = existing
        log.append({"step": "H19 webhook_endpoints.create (reused existing)", "ok": True})
    else:
        endpoint = run_step(
            "H19 webhook_endpoints.create",
            lambda: _post_with_key(
                client,
                "/v1/webhook-endpoints",
                {
                    "url": webhook_url,
                    "events": [
                        "invoice.finalized",
                        "invoice.transmitted",
                        "invoice.paid",
                        "quote.accepted",
                        "credit_note.finalized",
                    ],
                    "description": "Atelier Dupont demo (python-sdk)",
                },
                idempotency_key("create-webhook-endpoint", RUN_ID),
            ),
            log,
        )
    endpoint_id = endpoint.get("id")
    state["webhook_endpoint_id"] = endpoint_id
    # The signing secret is only returned at creation time — surface it so the
    # operator can copy it into FACTURINO_WEBHOOK_SECRET if it is new.
    if endpoint.get("secret"):
        state["webhook_endpoint_secret_hint"] = "returned at creation — set FACTURINO_WEBHOOK_SECRET to it"

    if endpoint_id:
        run_step("H19 webhook_endpoints.list", lambda: list(client.webhook_endpoints.list(limit=25)), log)
        run_step("H19 webhook_endpoints.get", lambda: client.webhook_endpoints.get(endpoint_id), log)
        # H20 — test delivery; the real /webhooks route (see webhooks.py)
        # verifies the signature and dispatches by event type.
        _optional(log, "H20 webhook_endpoints.test", lambda: client.webhook_endpoints.test(endpoint_id))

    # H21 — events replay surface.
    events_page = run_step("H21 events.list", lambda: list(client.events.list(limit=25)), log)
    event = events_page[0] if isinstance(events_page, list) and events_page else None
    if isinstance(event, dict) and event.get("id"):
        eid = event["id"]
        run_step("H21 events.get", lambda: client.events.get(eid), log)
        _optional(log, "H21 events.retry", lambda: client.events.retry(eid))


# --------------------------------------------------------------------------- #
# Phase I — Accounting & reporting
# --------------------------------------------------------------------------- #


def phase_i_accounting(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """I. Reporting, exports (FEC / invoices / RGPD), e-reporting, archives."""
    period = {"period_start": "2026-01-01", "period_end": "2026-12-31"}

    # I22 — reporting (Essential+).
    _optional(log, "I22 reporting.vat", lambda: client.reporting.vat(**period))
    _optional(log, "I22 reporting.revenue", lambda: client.reporting.revenue(group_by="month", **period))

    # I23 — exports. FEC + status (Pro+), bulk invoices (all plans), RGPD.
    fec = _optional(
        log,
        "I23 exports.generate_fec",
        lambda: client.exports.generate_fec(period_start="2026-01-01", period_end="2026-12-31"),
    )
    if isinstance(fec, dict):
        fec_job = extract_job_id(fec)
        if fec_job:
            _optional(log, "I23 exports.get_fec_status", lambda: client.exports.get_fec_status(fec_job))
    _optional(
        log,
        "I23 exports.export_invoices",
        lambda: client.exports.export_invoices(period_start="2026-01-01", period_end="2026-12-31"),
    )
    # RGPD (article 20) data export is account-level — covered in phase J via
    # account.request_export + account.download_export.

    # I24 — e-reporting declarations (B2C / international).
    declaration = _optional(
        log,
        "I24 ereporting.create_declaration",
        lambda: client.ereporting.create_declaration(
            type="b2c",
            period="2026-05",
            lines=[{"category": "standard", "amount": 120000, "vatRate": 2000, "vatAmount": 24000}],
        ),
    )
    _optional(log, "I24 ereporting.list", lambda: list(client.ereporting.list(limit=25)))
    if isinstance(declaration, dict) and declaration.get("id"):
        did = declaration["id"]
        _optional(log, "I24 ereporting.get", lambda: client.ereporting.get(did))
        _optional(log, "I24 ereporting.submit_declaration", lambda: client.ereporting.submit_declaration(did))

    # I25 — archives (hash-chain verified, read-only).
    archives_page = _optional(log, "I25 archives.list", lambda: list(client.archives.list(limit=25)))
    archive = archives_page[0] if isinstance(archives_page, list) and archives_page else None
    invoice_id = state.get("invoice_id")
    if isinstance(archive, dict) and archive.get("invoiceId"):
        _optional(log, "I25 archives.get", lambda: client.archives.get(archive["invoiceId"]))
    elif invoice_id:
        _optional(log, "I25 archives.get", lambda: client.archives.get(invoice_id))


# --------------------------------------------------------------------------- #
# Phase J — Account administration
# --------------------------------------------------------------------------- #


def phase_j_admin(client: facturino.Client, log: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """J. Facturino billing (read-only) and the RGPD data export."""
    # J29 — Facturino's own subscription billing.
    _optional(log, "J29 billing.retrieve_subscription", client.billing.retrieve_subscription)
    _optional(log, "J29 billing.list_invoices", lambda: client.billing.list_invoices(limit=10))
    billing_invoices = _safe(lambda: client.billing.list_invoices(limit=1))
    bi = first(billing_invoices) if billing_invoices else None
    if isinstance(bi, dict) and bi.get("id"):
        _optional(log, "J29 billing.get_invoice_pdf", lambda: client.billing.get_invoice_pdf(bi["id"]))

    # J30 — RGPD: request a data export. It runs ASYNC — POST /account/export returns
    # a 202 job (object:"job", id:"job_…"). The download URL surfaces on the job
    # itself (GET /v1/exports/:jobId → download_url once the worker finished).
    # account.download_export takes the "rgpdexp_…" id delivered by the
    # export_ready notification, NOT the job id — it is not used here.
    export = _optional(log, "J30 account.request_export", client.account.request_export)
    export_id = extract_job_id(export) if isinstance(export, dict) else None
    if export_id:
        _optional(log, "J30 export poll", lambda: poll_job(client, export_id, timeout=30.0))
        status = _optional(log, "J30 exports.get_status", lambda: client.exports.get_status(export_id))
        if isinstance(status, dict) and status.get("download_url"):
            log.append({"step": "J30 download URL ready", "ok": True})


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #

PHASES = {
    "a": "Bootstrap account",
    "b": "Catalogue & customer",
    "c": "Quote -> invoice",
    "d": "Invoice lifecycle",
    "k": "Decision-first billing",
    "e": "Recurring subscription",
    "f": "Credit note",
    "g": "Purchases (received invoices)",
    "h": "Webhooks",
    "i": "Accounting & reporting",
    "j": "Account administration",
}


def run_all(client: facturino.Client, *, webhook_url: str) -> dict[str, Any]:
    """Run the complete A->J journey and return a structured run report."""
    log: list[dict[str, Any]] = []
    state: dict[str, Any] = {"webhook_url": webhook_url}

    state.update(phase_a_bootstrap(client, log))
    phase_b_catalog(client, log, state)
    phase_c_quote(client, log, state)
    phase_d_invoice(client, log, state)
    phase_e_recurring(client, log, state)
    phase_k_tax_decision(client, log, state)
    phase_k_deposit_and_schedule(client, log, state)
    phase_k_decided_credit_note(client, log, state)
    phase_k_decided_recurring(client, log, state)
    phase_k_integration(client, log, state)
    phase_f_credit_note(client, log, state)
    phase_g_received(client, log, state)
    phase_h_webhooks(client, log, state)
    phase_i_accounting(client, log, state)
    phase_j_admin(client, log, state)

    return {"ok": all(entry.get("ok", True) for entry in log), "state": state, "log": log}


def run_phase(client: facturino.Client, phase: str, *, webhook_url: str, state: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Run a single phase. Earlier phases that produce required ids are
    re-run (cheaply, thanks to lookup-or-create) when state is absent.
    """
    phase = phase.lower()
    if phase not in PHASES:
        raise ValueError(f"Unknown phase {phase!r}; valid phases: {', '.join(PHASES)}")

    log: list[dict[str, Any]] = []
    state = dict(state or {})
    state.setdefault("webhook_url", webhook_url)

    # Bootstrap the minimal prerequisites for the requested phase. Phase A
    # always runs (it resolves the company id every later phase needs).
    state.update(phase_a_bootstrap(client, log))
    needs_customer = phase in ("b", "c", "d", "e", "f", "g", "k")
    if needs_customer and "customer_id" not in state:
        phase_b_catalog(client, log, state)

    if phase == "c":
        phase_c_quote(client, log, state)
    elif phase == "d":
        phase_d_invoice(client, log, state)
    elif phase == "e":
        phase_e_recurring(client, log, state)
    elif phase == "k":
        phase_k_tax_decision(client, log, state)
        phase_k_deposit_and_schedule(client, log, state)
        phase_k_decided_credit_note(client, log, state)
        phase_k_decided_recurring(client, log, state)
        phase_k_integration(client, log, state)
    elif phase == "f":
        # The credit note needs a finalized invoice; create one if missing.
        if "invoice_id" not in state:
            phase_d_invoice(client, log, state)
        phase_f_credit_note(client, log, state)
    elif phase == "g":
        phase_g_received(client, log, state)
    elif phase == "h":
        phase_h_webhooks(client, log, state)
    elif phase == "i":
        phase_i_accounting(client, log, state)
    elif phase == "j":
        phase_j_admin(client, log, state)
    # phases "a" and "b" are fully covered by the bootstrap above.

    return {"ok": all(entry.get("ok", True) for entry in log), "phase": phase, "state": state, "log": log}


# --------------------------------------------------------------------------- #
# Internal helpers
# --------------------------------------------------------------------------- #


def _optional(log: list[dict[str, Any]], label: str, fn: Any) -> Any:
    """Run a step that may legitimately fail on this plan / data set.

    Plan-gated (402), permission (403) and not-found (404) errors are
    recorded as informational and swallowed; everything else is recorded as
    a real failure but still swallowed so one optional step cannot abort the
    journey. Returns the result, or ``None`` on any error.
    """
    try:
        result = fn()
        log.append({"step": label, "ok": True})
        return result
    except (PlanLimitError, PermissionDeniedError, NotFoundError) as exc:
        log.append({"step": label, "ok": True, "skipped": True, "reason": f"{exc.code or exc.type}", "request_id": exc.request_id})
        return None
    except ApiError as exc:
        log.append({"step": label, "ok": False, "code": exc.code, "message": exc.message, "request_id": exc.request_id})
        return None


def _safe(fn: Any) -> Any:
    """Best-effort call that returns ``None`` instead of raising."""
    try:
        return fn()
    except ApiError:
        return None


def _public(state: dict[str, Any]) -> str:
    url = state.get("webhook_url", "")
    return url[: -len("/webhooks")] if url.endswith("/webhooks") else url


def _invoice_total(invoice: dict[str, Any]) -> int:
    """Best-effort extraction of the invoice TTC total in integer centimes."""
    for key in ("totalTtc", "total_ttc", "amountDue", "amount_due", "total"):
        value = invoice.get(key)
        if isinstance(value, int):
            return value
    totals = invoice.get("totals")
    if isinstance(totals, dict):
        for key in ("ttc", "totalTtc", "amountDue"):
            value = totals.get(key)
            if isinstance(value, int):
                return value
    # Matches the two demo lines: 2*600.00 + 99.00 = 1299.00 EUR, +20% VAT.
    return 155880


def _resolve_document(client: facturino.Client, log: list[dict[str, Any]], label: str, fn: Any) -> None:
    """Call a document endpoint and, if it returns a 202 job, poll it."""
    try:
        result = fn()
    except (PlanLimitError, PermissionDeniedError, NotFoundError) as exc:
        log.append({"step": label, "ok": True, "skipped": True, "reason": exc.code or exc.type})
        return
    except ApiError as exc:
        log.append({"step": label, "ok": False, "code": exc.code, "request_id": exc.request_id})
        return

    job_id = extract_job_id(result) if isinstance(result, dict) else None
    if job_id:
        try:
            poll_job(client, job_id, timeout=30.0)
            log.append({"step": f"{label} (+ jobs.get poll)", "ok": True})
        except (TimeoutError, ApiError) as exc:
            log.append({"step": f"{label} (poll)", "ok": False, "message": str(exc)})
    else:
        log.append({"step": label, "ok": True})


def _drive_pa_lifecycle(client: facturino.Client, log: list[dict[str, Any]], invoice_id: str) -> None:
    """In test mode, force the PA status chain so webhooks fire deterministically.

    Production PAs advance these statuses asynchronously over minutes/hours;
    ``sandbox.simulate_status`` lets the demo show the full chain instantly.
    """
    for status in ("deposited", "transmitted", "available", "received", "approved"):
        _optional(
            log,
            f"D11 sandbox.simulate_status -> {status}",
            lambda s=status: client.sandbox.simulate_status(invoice_id, s),
        )


def _find_customer_by_email(client: facturino.Client, email: str) -> Optional[dict[str, Any]]:
    """Lookup-or-create support: scan customers for a matching email."""
    try:
        for customer in client.customers.list(limit=100):
            if customer.get("email") == email:
                return customer
    except ApiError:
        return None
    return None


def _find_endpoint_by_url(client: facturino.Client, url: Optional[str]) -> Optional[dict[str, Any]]:
    """Lookup-or-create support: find an existing webhook endpoint by URL."""
    if not url:
        return None
    try:
        for endpoint in client.webhook_endpoints.list(limit=100):
            if endpoint.get("url") == url:
                return endpoint
    except ApiError:
        return None
    return None
