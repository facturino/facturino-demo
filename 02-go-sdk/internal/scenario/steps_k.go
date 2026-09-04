package scenario

import (
	"context"
	"fmt"
	"time"

	facturino "github.com/facturino/facturino-go/v2"
)

// StepTaxDecision covers the decision-first journey: decide, collect the
// decided amount, verify after settlement, then invoice against the decision.
//
// The order is the point. The VAT and the exact amount to debit come from
// Facturino BEFORE anything is collected, and the decision id travels with the
// settlement so what was received can be checked against what was decided.
//
// Facturino imposes no payment service provider and no payment method. The flow
// below is provider-neutral: the decision id is carried in the payment
// REFERENCE, which every settlement has — a transfer, a direct debit, a cheque,
// cash, or a PSP capture. Two PSP variants are shown afterwards as examples;
// both are simulated locally, and no PSP is ever contacted.
//
//	taxDecisions.Create/Retrieve, invoices.Create (decision-backed), Finalize,
//	Send, payments.Create.
func (r *Runner) StepTaxDecision(ctx context.Context) error {
	if r.state.CustomerID == "" {
		return fmt.Errorf("no customer in state; run phase B first")
	}

	// 1. Decide BEFORE any payment. The idempotency key is stable for this
	// order, so replaying the phase replays the same decision.
	r.log.Step("taxDecisions.Create")
	decision, err := r.client.TaxDecisions.Create(&facturino.TaxDecisionParams{
		// Facturino determines the VAT; "integration" is the other journey,
		// shown in StepIntegrationDecision.
		TaxSource: "facturino",
		Customer:  r.state.CustomerID,
		// The effective date drives the applicable rules — not the wall clock.
		EffectiveAt: time.Now().Format("2006-01-02"),
		Currency:    "eur",
		PriceMode:   "tax_exclusive",
		Lines: []*facturino.TaxDecisionLineParams{{
			Reference:   "abo-pro",
			Description: "Abonnement Atelier Pro (mensuel)",
			// A subscription delivered online is an electronically supplied
			// service: it carries its own place-of-supply rules.
			Category:     "electronically_supplied_services",
			RateCategory: "standard",
			UnitAmount:   4900, // integer centimes
			Quantity:     "1",  // decimal STRING, never a float
		}},
		IdempotencyKey: r.idemKey("tax-decision"),
	})
	if err != nil {
		return fmt.Errorf("taxDecisions.Create: %w", err)
	}
	r.log.OK("decision %s — status=%s", decision.ID, decision.Status)

	// 2. Stop immediately unless the decision is final. "pending_verification"
	// does not mean "nothing to charge": the amounts are nil, not zero.
	if !decision.IsFinal() || decision.AmountToCharge == nil {
		for _, issue := range decision.Issues {
			r.log.Warnf("missing: %s — %s", issue.Code, issue.Message)
		}
		r.log.Warnf("decision is not final: nothing is charged and no invoice is issued")
		return nil
	}

	// 3. Collect exactly what was decided, in the decided currency.
	amountToCharge := *decision.AmountToCharge
	r.log.Infof("collect %d centimes %s — decided, not computed here", amountToCharge, decision.Currency)

	// 4. Carry the decision id in the settlement REFERENCE, whatever the means.
	// Every settlement has one: a transfer wording, a direct-debit mandate
	// reference, a cheque number, a PSP charge id. That reference is what lets
	// step 6 verify what was actually received.
	settlementReference := decision.ID
	// transfer, card, check, cash, direct_debit, sepa, paypal or other
	settlementMethod := "transfer"
	r.log.Infof("settlement reference %s — %d centimes by %s",
		settlementReference, amountToCharge, settlementMethod)

	// 4b. OPTIONAL, for a PSP-collected payment. Two examples, nothing more:
	// Facturino requires neither. Simulated locally — no call is made.
	r.log.Infof("optional psp variants — stripe metadata %v | paypal custom_id=%s value=%s",
		map[string]string{"facturino_tax_decision_id": decision.ID},
		decision.ID,
		fmt.Sprintf("%.2f", float64(amountToCharge)/100), // PayPal wants decimal units
	)

	// 5. Once settled, read the decision back from the reference carried with
	// the payment.
	source, err := r.client.TaxDecisions.Retrieve(settlementReference)
	if err != nil {
		return fmt.Errorf("taxDecisions.Retrieve: %w", err)
	}

	// 6. Verify amount, currency and buyer. A mismatch means the settlement and
	// the invoice would not describe the same operation.
	if source.AmountToCharge == nil || amountToCharge != *source.AmountToCharge {
		return fmt.Errorf("settled amount differs from the decision")
	}
	if decision.Currency != source.Currency {
		return fmt.Errorf("settled currency differs from the decision")
	}
	if r.state.CustomerID != source.CustomerID {
		return fmt.Errorf("settled buyer differs from the decision")
	}
	r.log.OK("settlement matches the decision: amount, currency and buyer")

	// 7. The invoice is backed by the decision. No VAT is restated: a decision
	// line is referenced, and the document line carries presentation only.
	invoice, err := r.client.Invoices.Create(&facturino.InvoiceParams{
		Customer:      source.CustomerID,
		TaxDecisionID: source.ID,
		DecisionLines: []*facturino.DecisionLineParams{{
			TaxLineRef: "abo-pro",
			Unit:       "month",
			Product:    r.state.SubscriptionProductID,
		}},
		Buyer: &facturino.BuyerParams{
			CompanyName: "Menuiserie Lemoine SARL",
			Siret:       "55204944776279",
			VATNumber:   "FR40552049447",
			Address:     &facturino.Address{Line1: "12 rue des Artisans", PostalCode: "69007", City: "Lyon", Country: "FR"},
			// BG-7 delivery address (CIUS-FR requirement).
			DeliveryAddress: &facturino.Address{Line1: "Entrepot Est, 4 allee du Bois", PostalCode: "69800", City: "Saint-Priest", Country: "FR"},
		},
		Dates:          &facturino.InvoiceDatesParams{Issued: today(), Due: inDays(30)},
		Payment:        &facturino.PaymentTermsParams{Terms: "30 jours net", TermsDays: 30, Method: "transfer", LatePaymentRate: "10.00", CollectionFee: "40.00"},
		IdempotencyKey: r.idemKey("tax-decision-invoice"),
	})
	if err != nil {
		return fmt.Errorf("invoices.Create (decision-backed): %w", err)
	}

	// 8. Finalize WITH the collection. The money was received at step 5 and
	// verified at step 7, so the invoice is issued acquitted: the number and
	// the payment are applied in the SAME transaction, and the original
	// Factur-X is rendered on a settled document instead of one that says "to
	// pay". A collection above what is due is refused
	// (payment_exceeds_amount_due) and the invoice stays a draft — no number
	// is burned.
	finalized, err := r.client.Invoices.FinalizeWithPayment(invoice.ID, &facturino.PaymentParams{
		Amount:    amountToCharge,
		Method:    settlementMethod,
		Reference: settlementReference,
		PaidAt:    today(),
	})
	if err != nil {
		return fmt.Errorf("invoices.FinalizeWithPayment: %w", err)
	}
	r.log.OK("invoice %s — taxSource=%s", finalized.Number, finalized.TaxSource)

	// 9. Send to the platform ONLY on the channel the decision states.
	if source.InvoiceChannel != nil && *source.InvoiceChannel == "einvoicing" {
		if _, err := r.client.Invoices.Send(finalized.ID); err != nil {
			return fmt.Errorf("invoices.Send: %w", err)
		}
		r.log.OK("sent to the connected platform (invoiceChannel = einvoicing)")
	} else {
		// Not a failure: the operation is simply outside the e-invoicing
		// channel. Calling invoices.Send here would be refused, and rightly so.
		r.log.Infof("invoiceChannel=%s — no platform deposit; the obligation, if any, goes through e-reporting",
			deref(source.InvoiceChannel))
	}

	// 10. Keep the reporting axes: they are the obligations, and they hold
	// whether or not the invoice travelled the network.
	r.log.Infof("axes — transaction=%s | payment=%s",
		deref(source.TransactionReporting), deref(source.PaymentReporting))
	for _, reason := range source.ObligationReasons {
		r.log.Infof("  %s: %s (%s)", reason.Axis, reason.Code, reason.Reference)
	}
	if source.ForeignTaxReviewRequired {
		// Facturino decides French VAT and the matching French obligations only.
		r.log.Warnf("foreignTaxReviewRequired: a foreign tax may apply — review it outside Facturino")
	}

	// 11. Read the ledger back. Nothing is recorded here: the collection was
	// applied with the finalization, so this only proves it is there, with the
	// reference that carries the decision id.
	ledger := r.client.Payments.List(finalized.ID, nil)
	for ledger.Next() {
		entry := ledger.Payment()
		r.log.OK("collection on the ledger — %d cents by %s, reference %s",
			entry.Amount, entry.Method, entry.Reference)
	}
	if err := ledger.Err(); err != nil {
		return fmt.Errorf("payments.List: %w", err)
	}

	// The three status axes, read off the invoice AS ISSUED — already settled.
	r.log.Infof("invoice axes — document=%s | transmission=%s | payment=%s (expected paid)",
		finalized.DocumentStatus, finalized.TransmissionStatus, finalized.PaymentStatus)
	r.log.Infof("settled on %s — dates.paidAt is the REAL collection date", invoicePaidAt(finalized))

	r.state.TaxDecisionID = source.ID
	r.state.DecidedInvoiceID = finalized.ID
	return nil
}

// StepDecidedCreditNote credits a DECIDED invoice.
//
// creditedLines references the decided lines; the rate, the category, the VATEX
// code and the legal mention are inherited from the invoice's frozen snapshot.
// Restating them through Items is refused, and should be.
func (r *Runner) StepDecidedCreditNote(ctx context.Context) error {
	if r.state.DecidedInvoiceID == "" {
		r.log.Skip("no final decision in this run; no decided invoice to credit")
		return nil
	}

	r.log.Step("creditNotes.Create (creditedLines)")
	creditNote, err := r.client.CreditNotes.Create(&facturino.CreditNoteParams{
		RelatedInvoiceID: r.state.DecidedInvoiceID,
		CreditNoteType:   "partial",
		ReasonCode:       "quality",
		Reason:           "Partial credit on a decided invoice",
		// Either Quantity or AmountTTC, never both. Leaving both empty credits
		// the line's whole remaining balance.
		CreditedLines:  []*facturino.CreditedLineParams{{TaxLineRef: "abo-pro", AmountTTC: 1200}},
		Dates:          &facturino.CreditNoteDates{Issued: today()},
		IdempotencyKey: r.idemKey("decided-credit-note"),
	})
	if err != nil {
		return fmt.Errorf("creditNotes.Create: %w", err)
	}
	r.log.OK("credit note %s — inherits decision %s", creditNote.ID, creditNote.OriginalTaxDecisionID)
	return nil
}

// StepDecidedRecurring creates a recurrence on the decided journey.
//
// TaxInputs carries the OPERATION, not a decision: a recurrence never stores
// one. Each occurrence is decided on its own effective date, so a schedule
// created today does not carry this quarter's rules into next year.
func (r *Runner) StepDecidedRecurring(ctx context.Context) error {
	if r.state.CustomerID == "" {
		return fmt.Errorf("no customer in state; run phase B first")
	}

	r.log.Step("recurringInvoices.Create (taxInputs)")
	rec, err := r.client.RecurringInvoices.Create(&facturino.RecurringInvoiceParams{
		CustomerID:         r.state.CustomerID,
		Frequency:          "monthly",
		StartDate:          firstOfNextMonth(),
		NextGenerationDate: firstOfNextMonth(),
		TaxInputs: &facturino.RecurringTaxInputsParams{
			TaxSource: "facturino",
			PriceMode: "tax_exclusive",
			Lines: []*facturino.RecurringTaxLineParams{{
				TaxDecisionLineParams: facturino.TaxDecisionLineParams{
					Reference:    "abo-pro",
					Description:  "Abonnement Atelier Pro (mensuel)",
					Category:     "electronically_supplied_services",
					RateCategory: "standard",
					UnitAmount:   4900,
					Quantity:     "1",
				},
				Unit:    "month",
				Product: r.state.SubscriptionProductID,
			}},
		},
		// TemplateInvoice carries presentation and terms only — never a rate.
		TemplateInvoice: &facturino.RecurringTemplateParams{
			PaymentMethod:    "transfer",
			PaymentTermsDays: 30,
		},
		IdempotencyKey: r.idemKey("decided-recurring"),
	})
	if err != nil {
		return fmt.Errorf("recurringInvoices.Create: %w", err)
	}
	r.log.OK("recurrence %s — every occurrence is decided on its own date", rec.ID)
	return nil
}

// invoicePaidAt renders the REAL settlement date carried by the invoice.
func invoicePaidAt(invoice *facturino.Invoice) string {
	if invoice.Dates == nil || invoice.Dates.PaidAt == "" {
		return "—"
	}
	return invoice.Dates.PaidAt
}

// deref renders an optional string field, defaulting to "none".
func deref(value *string) string {
	if value == nil {
		return "none"
	}
	return *value
}

// StepDepositAndSchedule issues a deposit invoice (386), settles it, then
// deducts it from the balance invoice.
//
// The order matters and is the point of this step: a deposit is deducted as
// PREPAID (BT-113), and an amount is only prepaid once it has actually been
// collected. So the deposit is decided, then ISSUED SETTLED — finalization and
// full payment in one call — before it is attached to the balance invoice. A
// deposit that is merely finalized has been invoiced, not paid, and presenting
// it as prepaid would overstate what the buyer already settled; issued
// acquitted, the deposit never exists in that state at all.
//
// The schedule is validated against the amount that remains DUE — the total
// less the prepaid deposit — never against the gross total.
func (r *Runner) StepDepositAndSchedule(ctx context.Context) error {
	if r.state.CustomerID == "" {
		return fmt.Errorf("no customer in state; run phase B first")
	}

	buyer := &facturino.BuyerParams{
		CompanyName: "Menuiserie Lemoine SARL",
		Siret:       "55204944776279",
		Address:     &facturino.Address{Line1: "12 rue des Artisans", PostalCode: "69007", City: "Lyon", Country: "FR"},
	}
	payment := &facturino.PaymentTermsParams{Terms: "30 jours net", TermsDays: 30, Method: "transfer", LatePaymentRate: "10.00", CollectionFee: "40.00"}

	// 1. Decide the deposit operation (type 386): a `deposit` line names the
	// principal supply it follows through RelatedCategory.
	depositDecision, err := r.decide([]*facturino.TaxDecisionLineParams{
		{Reference: "acompte-prestation", Description: "Prestation — acompte", Category: "deposit", RelatedCategory: "services", RateCategory: "standard", UnitAmount: 24000, Quantity: "1"},
	}, "deposit-decision")
	if err != nil {
		return err
	}
	if depositDecision == nil {
		r.log.Warnf("the deposit decision is not final; skipping the block")
		return nil
	}
	r.log.Step("invoices.Create (type=deposit, from the decision)")
	depositDraft, err := r.client.Invoices.Create(&facturino.InvoiceParams{
		Customer:      r.state.CustomerID,
		Type:          "deposit",
		Buyer:         buyer,
		TaxDecisionID: depositDecision.ID,
		DecisionLines: []*facturino.DecisionLineParams{
			{TaxLineRef: "acompte-prestation", Unit: "unit"},
		},
		Dates:          &facturino.InvoiceDatesParams{Issued: today(), Due: inDays(30)},
		Payment:        payment,
		IdempotencyKey: r.idemKey("deposit-draft"),
	})
	if err != nil {
		return fmt.Errorf("invoices.Create (deposit): %w", err)
	}

	// 2. Finalize WITH the payment IN FULL — exactly the decided amount, in a
	// single call. An amount is only prepaid once it has been collected, and
	// issuing the deposit acquitted is the strongest form of that rule: the
	// deposit never exists unpaid, so it can never be deducted before it was
	// settled.
	deposit, err := r.client.Invoices.FinalizeWithPayment(depositDraft.ID, &facturino.PaymentParams{
		Amount:         *depositDecision.AmountToCharge,
		Method:         "transfer",
		Reference:      depositDecision.ID,
		PaidAt:         today(),
		IdempotencyKey: r.idemKey("deposit-final"),
	})
	if err != nil {
		return fmt.Errorf("invoices.FinalizeWithPayment (deposit): %w", err)
	}
	r.log.OK("deposit %s issued settled", deposit.Number)

	// 3. The settlement is read off the ISSUED deposit, not fetched afterwards.
	if deposit.PaymentStatus != "paid" && deposit.Status != "paid" {
		// Attaching an unsettled deposit would misstate BT-113.
		r.log.Warnf("deposit %s is not settled — not attaching it to the balance invoice", deposit.Number)
		return nil
	}
	r.log.OK("deposit %s settled on %s — it may now be deducted as prepaid (BT-113)",
		deposit.Number, invoicePaidAt(deposit))

	// 4. Decide the balance operation, then deduct the SETTLED deposit and
	// split what remains into instalments. Deposits and schedule settle
	// SERVER-SIDE against the decided amount (BT-113/BT-115); the instalments
	// distribute exactly what remains due, the last one on the due date (BT-9).
	balanceDecision, err := r.decide([]*facturino.TaxDecisionLineParams{
		{Reference: "prestation-atelier", Description: "Prestation d'atelier", Category: "services", RateCategory: "standard", UnitAmount: 8000, Quantity: "10"},
	}, "balance-decision")
	if err != nil {
		return err
	}
	if balanceDecision == nil {
		r.log.Warnf("the balance decision is not final; skipping the block")
		return nil
	}
	stillDue := *balanceDecision.AmountToCharge - *depositDecision.AmountToCharge
	firstInstalment := stillDue / 2
	balanceDraft, err := r.client.Invoices.Create(&facturino.InvoiceParams{
		Customer:      r.state.CustomerID,
		Buyer:         buyer,
		TaxDecisionID: balanceDecision.ID,
		DecisionLines: []*facturino.DecisionLineParams{
			{TaxLineRef: "prestation-atelier", Unit: "hour"},
		},
		Dates:    &facturino.InvoiceDatesParams{Issued: today(), Due: inDays(30)},
		Payment:  payment,
		Deposits: []*facturino.DepositParam{{InvoiceID: deposit.ID}},
		Schedule: []*facturino.ScheduleParam{
			{Amount: firstInstalment, DueDate: inDays(15), Label: "Premier versement"},
			{Amount: stillDue - firstInstalment, DueDate: inDays(30), Label: "Solde"},
		},
		IdempotencyKey: r.idemKey("balance-draft"),
	})
	if err != nil {
		return fmt.Errorf("invoices.Create (balance): %w", err)
	}
	balance, err := r.client.Invoices.Finalize(balanceDraft.ID)
	if err != nil {
		return fmt.Errorf("invoices.Finalize (balance): %w", err)
	}
	r.log.OK("balance invoice %s — total %d | prepaid %d | due %d (centimes)",
		balance.Number, balance.Totals.TotalTTC, balance.Totals.AmountPaid, balance.Totals.AmountDue)

	r.state.DepositInvoiceID = deposit.ID
	return nil
}

// StepIntegrationDecision shows the OTHER fiscal journey: the VAT is
// supplied by the integration (taxSource "integration"). An ERP or an
// in-house rules service that already determines the VAT declares it on the
// decision; Facturino validates the coherence of what is supplied and
// refuses contradictions (integration_vat_incoherent) — it never silently
// corrects a rate. The decision, the invoice and the reporting obligations
// then work exactly as on the "facturino" source: the two journeys are
// equals.
func (r *Runner) StepIntegrationDecision(ctx context.Context) error {
	if r.state.CustomerID == "" {
		return fmt.Errorf("no customer in state; run phase B first")
	}

	standardRate := 2000
	r.log.Step("taxDecisions.Create (taxSource=integration)")
	decision, err := r.client.TaxDecisions.Create(&facturino.TaxDecisionParams{
		TaxSource:   "integration",
		Customer:    r.state.CustomerID,
		EffectiveAt: today(),
		Currency:    "eur",
		PriceMode:   "tax_exclusive",
		Lines: []*facturino.TaxDecisionLineParams{{
			Reference:   "conseil-integ",
			Description: "Prestation de conseil (TVA fournie par l'ERP)",
			Category:    "services",
			UnitAmount:  10000,
			Quantity:    "1",
			VatRate:     &standardRate, // 20,00 % — concluded by YOUR system
			VatCode:     "S",
		}},
		IdempotencyKey: r.idemKey("integration-decision"),
	})
	if err != nil {
		return fmt.Errorf("taxDecisions.Create (integration): %w", err)
	}
	if !decision.IsFinal() || decision.AmountToCharge == nil {
		for _, issue := range decision.Issues {
			r.log.Warnf("missing: %s — %s", issue.Code, issue.Message)
		}
		return nil
	}
	r.log.OK("integration decision %s — %d centimes (taxSource=%s)", decision.ID, *decision.AmountToCharge, decision.TaxSource)

	// The invoice is created from the decision exactly as on the facturino
	// source — same contract, same axes, same obligations engine.
	draft, err := r.client.Invoices.Create(&facturino.InvoiceParams{
		Customer:       r.state.CustomerID,
		Buyer:          mainBuyer(),
		TaxDecisionID:  decision.ID,
		DecisionLines:  []*facturino.DecisionLineParams{{TaxLineRef: "conseil-integ", Unit: "unit"}},
		Dates:          &facturino.InvoiceDatesParams{Issued: today(), Due: inDays(30)},
		Payment:        mainPaymentTerms(),
		IdempotencyKey: r.idemKey("integration-invoice"),
	})
	if err != nil {
		return fmt.Errorf("invoices.Create (integration): %w", err)
	}
	invoice, err := r.client.Invoices.Finalize(draft.ID)
	if err != nil {
		return fmt.Errorf("invoices.Finalize (integration): %w", err)
	}
	r.log.OK("invoice %s — taxSource=%s", invoice.Number, invoice.TaxSource)

	// A contradiction is refused, never corrected: a positive rate cannot
	// carry an exemption code.
	r.runStep("taxDecisions.Create (incoherent supplied VAT is refused)", func() error {
		_, err := r.client.TaxDecisions.Create(&facturino.TaxDecisionParams{
			TaxSource:   "integration",
			Customer:    r.state.CustomerID,
			EffectiveAt: today(),
			Currency:    "eur",
			PriceMode:   "tax_exclusive",
			Lines: []*facturino.TaxDecisionLineParams{{
				Reference:   "incoherent",
				Description: "Ligne incoherente (demonstration du refus)",
				Category:    "services",
				UnitAmount:  10000,
				Quantity:    "1",
				VatRate:     &standardRate,
				VatCode:     "S",
				VatexCode:   "VATEX-EU-G",
			}},
			IdempotencyKey: r.idemKey("integration-incoherent"),
		})
		if err == nil {
			return fmt.Errorf("the contradiction was accepted; it must be refused")
		}
		r.log.OK("contradiction refused, never corrected: %s", explain(err))
		return nil
	})

	return nil
}
