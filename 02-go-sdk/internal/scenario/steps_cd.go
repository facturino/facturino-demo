package scenario

import (
	"context"
	"fmt"

	facturino "github.com/facturino/facturino-go/v2"
)

// StepQuoteToInvoice covers phase C: issue a quote, send it, have it
// accepted (and capture the signature proof), then convert it to a draft
// invoice. It also runs a dry validation of the invoice payload before any
// invoice is created.
//
//	quotes.Create/Send/Get/Accept/GetPdf/GetSignatureProof/Convert,
//	validate.Run.
func (r *Runner) StepQuoteToInvoice(ctx context.Context) error {
	if r.state.CustomerID == "" {
		return fmt.Errorf("no customer in state; run phase B first")
	}

	// C.7 — Quote with the setup service + one month of subscription.
	r.log.Step("quotes.Create")
	quote, err := r.client.Quotes.Create(&facturino.QuoteParams{
		Customer:     r.state.CustomerID,
		ValidityDays: 30,
		Notes:        "Devis de mise en place + premier mois d'abonnement.",
		Items: []*facturino.ItemParams{
			{Description: "Prestation de mise en place", Quantity: "1", Unit: "flat_rate", UnitPrice: 75000, VATRate: 2000, VATCode: "S", Product: r.state.OneOffProductID},
			{Description: "Abonnement Atelier Pro (mois 1)", Quantity: "1", Unit: "month", UnitPrice: 4900, VATRate: 2000, VATCode: "S", Product: r.state.SubscriptionProductID},
		},
		IdempotencyKey: r.idemKey("quote"),
	})
	if err != nil {
		return err
	}
	r.state.QuoteID = quote.ID
	r.log.OK("quote %s status=%s", quote.ID, quote.Status)

	// C.7 — Send, read back, accept.
	r.runStep("quotes.Send", func() error {
		_, err := r.client.Quotes.Send(quote.ID)
		return err
	})
	r.runStep("quotes.Get", func() error {
		_, err := r.client.Quotes.Get(quote.ID)
		return err
	})
	r.runStep("quotes.GetPdf", func() error {
		doc, err := r.client.Quotes.GetPDF(quote.ID)
		if err == nil {
			logDocument(r.log, "quote PDF", doc)
		}
		return err
	})
	r.runStep("quotes.Accept", func() error {
		_, err := r.client.Quotes.Accept(quote.ID)
		return err
	})
	r.runStep("quotes.GetSignatureProof", func() error {
		_, err := r.client.Quotes.GetSignatureProof(quote.ID)
		return err
	})

	// C.7 — Re-propose a similar quote as a fresh draft (post-accept,
	// pre-convert) so the SaaS can pitch a follow-on offer.
	r.runStep("quotes.Clone (re-propose as draft)", func() error {
		clone, err := r.client.Quotes.Clone(quote.ID)
		if err == nil {
			r.log.OK("cloned draft quote %s status=%s", clone.ID, clone.Status)
		}
		return err
	})

	// C.8 — Dry validation of an invoice payload (EN16931 + CIUS-FR) with no
	// write. Even the pre-flight is decision-first: the decision is taken
	// before anything is validated, the validation persists nothing and does
	// not consume the decision — phase D reuses it for the real create.
	r.runStep("taxDecisions.Create + validate.Run (decision-backed payload)", func() error {
		decision, err := r.decide(mainOperationLines(r), "main-decision")
		if err != nil || decision == nil {
			return err
		}
		r.state.MainDecisionID = decision.ID
		res, err := r.client.Validate.Run(&facturino.InvoiceParams{
			Customer:      r.state.CustomerID,
			Buyer:         mainBuyer(),
			TaxDecisionID: decision.ID,
			DecisionLines: mainDecisionLines(r),
			Dates:         &facturino.InvoiceDatesParams{Issued: today(), Due: inDays(30)},
			Payment:       mainPaymentTerms(),
		})
		if err == nil {
			r.log.OK("valid=%t warnings=%d", res.Valid, len(res.Warnings))
		}
		return err
	})

	// C.7 — Convert the accepted quote into a COMMERCIAL draft: the quote's
	// VAT was indicative, so the draft awaits its own decision. Phase D binds
	// the decision to THIS invoice and finalizes it — the quote cycle runs on
	// one document, and the converted draft is never abandoned.
	r.runStep("quotes.Convert -> commercial draft", func() error {
		inv, err := r.client.Quotes.Convert(quote.ID)
		if err != nil {
			return err
		}
		if inv.ID == "" {
			return fmt.Errorf("quotes.Convert returned no invoice id; the quote cycle cannot continue")
		}
		if inv.CommercialDraft == nil || len(inv.CommercialDraft.Lines) == 0 {
			return fmt.Errorf("converted draft %s carries no commercial operation; the quote cycle cannot continue", inv.ID)
		}
		r.state.ConvertedInvoiceID = inv.ID
		r.state.ConvertedDraft = inv.CommercialDraft
		// The decision must take effect on the DRAFT's own issue date.
		if inv.Dates != nil {
			r.state.ConvertedIssuedOn = inv.Dates.Issued
		}
		r.log.OK("commercial draft %s from quote (not decided yet: taxSource null)", inv.ID)
		return nil
	})

	return nil
}

// decisionLinesFromDraft restates the operation a commercial draft carries, so
// the decision covers exactly it — same references, same amounts, no VAT.
func decisionLinesFromDraft(draft *facturino.CommercialDraft) []*facturino.TaxDecisionLineParams {
	lines := make([]*facturino.TaxDecisionLineParams, 0, len(draft.Lines))
	for _, line := range draft.Lines {
		lines = append(lines, &facturino.TaxDecisionLineParams{
			Reference:    line.Reference,
			Description:  line.Description,
			Category:     line.SupplyCategory,
			RateCategory: line.RateCategory,
			UnitAmount:   line.UnitPrice,
			Quantity:     line.Quantity,
			Discount:     line.Discount,
		})
	}
	return lines
}

// presentationFromDraft renders the decided lines on the document: unit and
// catalogue product only — the VAT comes from the decision.
func presentationFromDraft(draft *facturino.CommercialDraft) []*facturino.DecisionLineParams {
	lines := make([]*facturino.DecisionLineParams, 0, len(draft.Lines))
	for _, line := range draft.Lines {
		lines = append(lines, &facturino.DecisionLineParams{
			TaxLineRef: line.Reference,
			Unit:       line.Unit,
			Product:    line.Product,
		})
	}
	return lines
}

// mainBuyer is the buyer block (BG-7) shared by the main-operation documents.
func mainBuyer() *facturino.BuyerParams {
	return &facturino.BuyerParams{
		CompanyName: "Menuiserie Lemoine SARL",
		Siret:       "55204944776279",
		VATNumber:   "FR40552049447",
		Address:     &facturino.Address{Line1: "12 rue des Artisans", PostalCode: "69007", City: "Lyon", Country: "FR"},
		// BG-7 delivery address (CIUS-FR requirement).
		DeliveryAddress: &facturino.Address{Line1: "Entrepot Est, 4 allee du Bois", PostalCode: "69800", City: "Saint-Priest", Country: "FR"},
	}
}

func mainPaymentTerms() *facturino.PaymentTermsParams {
	return &facturino.PaymentTermsParams{Terms: "30 jours net", TermsDays: 30, Method: "transfer", LatePaymentRate: "10.00", CollectionFee: "40.00"}
}

// mainOperationLines describes the main commercial operation for a tax
// decision: no rate is stated — Facturino concludes.
func mainOperationLines(r *Runner) []*facturino.TaxDecisionLineParams {
	return []*facturino.TaxDecisionLineParams{
		{Reference: "mise-en-place", Description: "Prestation de mise en place", Category: "services", RateCategory: "standard", UnitAmount: 75000, Quantity: "1"},
		{Reference: "abo-pro-m1", Description: "Abonnement Atelier Pro (mois 1)", Category: "electronically_supplied_services", RateCategory: "standard", UnitAmount: 4900, Quantity: "1"},
	}
}

// mainDecisionLines renders the decided lines on the document: presentation
// only — the VAT comes from the decision.
func mainDecisionLines(r *Runner) []*facturino.DecisionLineParams {
	return []*facturino.DecisionLineParams{
		{TaxLineRef: "mise-en-place", Unit: "flat_rate", Product: r.state.OneOffProductID},
		{TaxLineRef: "abo-pro-m1", Unit: "month", Product: r.state.SubscriptionProductID},
	}
}

// StepInvoiceLifecycle covers phase D: create (or reuse) a draft, finalize
// it (numbering), generate its documents, deposit it to the PA, drive the
// PA status to "received" via the sandbox so webhooks fire, record a
// payment, send a reminder, verify the archive hash chain, read the audit
// trail and clone the invoice.
//
//	invoices.Create/Finalize/Get/GetStatus/GetPdf/GetFacturx/GetXml/Send/
//	CreatePaymentLink/CreatePortalLink/Remind/ListEvents/Verify/
//	GetAuditTrail/GenerateAuditTrailPdf/Clone, payments.Create/List,
//	jobs.Get (poll), sandbox.SimulateStatus.
func (r *Runner) StepInvoiceLifecycle(ctx context.Context) error {
	if r.state.CustomerID == "" {
		return fmt.Errorf("no customer in state; run phase B first")
	}

	// D.9 — The invoice is the one the QUOTE produced. Its commercial block is
	// read back from the converted draft: the line references are assigned
	// server-side at conversion, and the decision must state exactly the
	// operation the draft carries. The decision is then BOUND to that same
	// invoice — creating a second one would orphan the converted draft.
	var inv *facturino.Invoice
	var err error
	if r.state.ConvertedInvoiceID != "" {
		if r.state.ConvertedDraft == nil || len(r.state.ConvertedDraft.Lines) == 0 || r.state.ConvertedIssuedOn == "" {
			return fmt.Errorf("converted draft %s carries no commercial operation; the quote cycle cannot continue", r.state.ConvertedInvoiceID)
		}
		decision, derr := r.decideOn(
			decisionLinesFromDraft(r.state.ConvertedDraft),
			"converted-draft-decision",
			r.state.ConvertedIssuedOn,
		)
		if derr != nil {
			return derr
		}
		if decision == nil {
			return fmt.Errorf("the operation of draft %s is not decidable; no invoice is issued", r.state.ConvertedInvoiceID)
		}
		r.state.MainDecisionID = decision.ID

		r.log.Step("invoices.BindTaxDecision (converted quote draft %s)", r.state.ConvertedInvoiceID)
		inv, err = r.client.Invoices.BindTaxDecision(r.state.ConvertedInvoiceID, &facturino.BindTaxDecisionParams{
			TaxDecisionID:  decision.ID,
			DecisionLines:  presentationFromDraft(r.state.ConvertedDraft),
			IdempotencyKey: r.idemKey("bind-decision"),
		})
		if err != nil {
			return err
		}
		r.log.OK("decision %s bound to the converted draft %s", decision.ID, inv.ID)
	} else {
		// No quote ran: the invoice is created directly from its own decision.
		if r.state.MainDecisionID == "" {
			decision, derr := r.decide(mainOperationLines(r), "main-decision")
			if derr != nil {
				return derr
			}
			if decision == nil {
				return fmt.Errorf("the main decision is not final; cannot invoice")
			}
			r.state.MainDecisionID = decision.ID
		}
		r.log.Step("invoices.Create (from the decision)")
		inv, err = r.client.Invoices.Create(&facturino.InvoiceParams{
			Customer:      r.state.CustomerID,
			Buyer:         mainBuyer(),
			TaxDecisionID: r.state.MainDecisionID,
			DecisionLines: mainDecisionLines(r),
			Dates:         &facturino.InvoiceDatesParams{Issued: today(), Due: inDays(30)},
			Payment:       mainPaymentTerms(),
			// BT-13 buyer purchase-order reference.
			PurchaseOrderNumber: "PO-2026-0142",
			Notes:               "Merci pour votre confiance.",
			IdempotencyKey:      r.idemKey("invoice"),
		})
		if err != nil {
			return err
		}
	}
	r.state.InvoiceID = inv.ID
	r.log.OK("draft invoice %s taxSource=%s", inv.ID, inv.TaxSource)
	invID := r.state.InvoiceID

	// D.9 — Finalize: assigns the legal number atomically.
	r.log.Step("invoices.Finalize %s", invID)
	finalized, err := r.client.Invoices.Finalize(invID)
	if err != nil {
		return err
	}
	r.state.InvoiceNumber = finalized.Number
	r.log.OK("finalized as %s (status %s)", finalized.Number, finalized.Status)

	r.runStep("invoices.Get", func() error {
		_, err := r.client.Invoices.Get(invID)
		return err
	})
	r.runStep("invoices.GetStatus", func() error {
		st, err := r.client.Invoices.GetStatus(invID)
		if err == nil {
			r.log.OK("status=%s paStatus=%s", st.Status, st.Einvoicing.PAStatus)
		}
		return err
	})

	// D.9 — List the invoices issued from the converted quote
	// (convertedFrom filter), to trace the devis -> facture lineage.
	if r.state.QuoteID != "" {
		r.runStep("invoices.List (convertedFrom quote)", func() error {
			count := 0
			it := r.client.Invoices.List(&facturino.InvoiceListParams{
				ListParams:    facturino.ListParams{Limit: 25},
				ConvertedFrom: r.state.QuoteID,
			})
			for it.Next() {
				count++
			}
			if err := it.Err(); err != nil {
				return err
			}
			r.log.OK("%d invoices converted from %s", count, r.state.QuoteID)
			return nil
		})
	}

	// D.10 — Documents (PDF, Factur-X, CII + UBL XML). Generation may be
	// async (HTTP 202 with a job id): poll jobs.Get until ready.
	r.runStep("invoices.GetPdf (poll if async)", func() error {
		doc, err := r.client.Invoices.GetPDF(invID)
		if err != nil {
			return err
		}
		return r.resolveDocument(ctx, "PDF", doc)
	})
	r.runStep("invoices.GetFacturx (poll if async)", func() error {
		doc, err := r.client.Invoices.GetFacturX(invID)
		if err != nil {
			return err
		}
		return r.resolveDocument(ctx, "Factur-X", doc)
	})
	r.runStep("invoices.GetXml (CII)", func() error {
		data, err := r.client.Invoices.GetXML(invID, "")
		if err == nil {
			r.log.OK("CII XML: %d bytes", len(data))
		}
		return err
	})
	r.runStep("invoices.GetXml (UBL)", func() error {
		data, err := r.client.Invoices.GetXML(invID, "ubl")
		if err == nil {
			r.log.OK("UBL XML: %d bytes", len(data))
		}
		return err
	})

	// D.11 — Deposit to the PA.
	r.runStep("invoices.Send (deposit to PA)", func() error {
		inv, err := r.client.Invoices.Send(invID)
		if err == nil {
			r.log.OK("PA status=%s", inv.Status)
		}
		return err
	})

	// Determinism: drive the PA transitions with the sandbox so the webhook
	// chain fires without waiting on a real PA. End on "approved" so the
	// invoice is in a payable state for the settlement below.
	r.driveSandboxStatuses(invID, "transmitted", "available", "received", "approved")

	// D.12 — Payment: a link/portal for the buyer, then record the payment.
	r.runStep("invoices.CreatePaymentLink", func() error {
		link, err := r.client.Invoices.CreatePaymentLink(invID, &facturino.PaymentLinkParams{
			SuccessURL: "https://atelier-dupont.example/merci",
			CancelURL:  "https://atelier-dupont.example/annule",
		})
		if err == nil {
			r.log.OK("payment link: %s", link.URL)
		}
		return err
	})
	r.runStep("invoices.CreatePortalLink", func() error {
		link, err := r.client.Invoices.CreatePortalLink(invID)
		if err == nil {
			r.log.OK("portal link: %s", link.URL)
		}
		return err
	})
	// Signed payment token for an embedded/headless checkout (Pro+).
	r.runStep("invoices.CreatePaymentToken", func() error {
		tok, err := r.client.Invoices.CreatePaymentToken(invID)
		if err == nil {
			r.log.OK("payment token issued (expires %s)", tok.ExpiresAt)
		}
		return err
	})
	// D.12 — Dunning before settlement: a reminder can only be sent while the
	// invoice is still unpaid, so send it before recording the payment.
	r.runStep("invoices.Remind (level 1)", func() error {
		return r.client.Invoices.Remind(invID, &facturino.InvoiceRemindParams{Level: 1})
	})
	r.runStep("payments.Create (full settlement)", func() error {
		pay, err := r.client.Payments.Create(invID, &facturino.PaymentParams{
			Amount:         95880, // 750 + 49 = 799,00 HT -> 958,80 TTC (20% VAT)
			Method:         "transfer",
			Reference:      "VIR-2026-0142",
			PaidAt:         today(),
			IdempotencyKey: r.idemKey("payment"),
		})
		if err == nil {
			r.log.OK("payment %s amount=%.2f EUR", pay.ID, float64(pay.Amount)/100)
		}
		return err
	})
	r.runStep("payments.List", func() error {
		count := 0
		it := r.client.Payments.List(invID, &facturino.ListParams{Limit: 25})
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d payments recorded", count)
		return nil
	})
	r.runStep("invoices.ListEvents", func() error {
		list, err := r.client.Invoices.ListEvents(invID)
		if err == nil {
			r.log.OK("%d lifecycle events", len(list.Data))
		}
		return err
	})

	// D.14 — Audit trail: hash-chain verification + entries + PDF.
	r.runStep("invoices.Verify (hash chain)", func() error {
		v, err := r.client.Invoices.Verify(invID)
		if err == nil {
			r.log.OK("verified=%t chain_length=%d", v.Verified, v.ChainLength)
		}
		return err
	})
	r.runStep("invoices.GetAuditTrail", func() error {
		list, err := r.client.Invoices.GetAuditTrail(invID, &facturino.ListParams{Limit: 25})
		if err == nil {
			r.log.OK("%d audit entries", len(list.Data))
		}
		return err
	})
	r.runStep("invoices.GenerateAuditTrailPdf", func() error {
		_, err := r.client.Invoices.GenerateAuditTrailPDF(invID)
		return err
	})

	// D.15 — Clone for a one-off manual re-issue.
	r.runStep("invoices.Clone", func() error {
		clone, err := r.client.Invoices.Clone(invID)
		if err == nil {
			r.log.OK("cloned draft %s", clone.ID)
		}
		return err
	})

	return nil
}

// driveSandboxStatuses pushes the invoice through the given PA statuses
// using sandbox.SimulateStatus. It is a no-op outside test mode (the
// endpoint rejects live keys) and tolerates per-status failures so an
// already-advanced invoice does not abort the run.
func (r *Runner) driveSandboxStatuses(invID string, statuses ...string) {
	for _, st := range statuses {
		r.runStep(fmt.Sprintf("sandbox.SimulateStatus -> %s", st), func() error {
			res, err := r.client.Sandbox.SimulateStatus(invID, &facturino.SimulateStatusParams{Status: st})
			if err == nil {
				r.log.OK("now %s (simulated=%t)", res.Status, res.Simulated)
			}
			return err
		})
	}
}

// resolveDocument handles a DocumentResponse that may be ready (URL set) or
// still generating (job fields set, HTTP 202). When async, it polls
// jobs.Get until the job completes or the context is cancelled.
func (r *Runner) resolveDocument(ctx context.Context, label string, doc *facturino.DocumentResponse) error {
	if doc.URL != "" {
		r.log.OK("%s ready: %s", label, doc.URL)
		return nil
	}
	if doc.ID == "" {
		r.log.OK("%s: no URL and no job id (nothing to poll)", label)
		return nil
	}
	r.log.Infof("%s generating async, polling job %s", label, doc.ID)
	return r.pollJob(ctx, label, doc.ID)
}

// pollJob polls a generation job until it finishes. It backs off briefly
// between attempts and honours context cancellation. Document generation in
// the demo is expected to complete in a handful of attempts.
func (r *Runner) pollJob(ctx context.Context, label, jobID string) error {
	const maxAttempts = 10
	for attempt := 0; attempt < maxAttempts; attempt++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		job, err := r.client.Jobs.Get(jobID)
		if err != nil {
			return err
		}
		switch job.Status {
		case "completed", "succeeded", "done":
			r.log.OK("%s job %s done: %s", label, jobID, job.URL)
			return nil
		case "failed", "error":
			return fmt.Errorf("%s job %s failed: %s", label, jobID, job.Error)
		}
		sleepCtx(ctx, attempt)
	}
	r.log.Infof("%s job %s still pending after %d polls (continuing)", label, jobID, maxAttempts)
	return nil
}

// logDocument prints a one-line summary of a document response.
func logDocument(log *Logger, label string, doc *facturino.DocumentResponse) {
	if doc.URL != "" {
		log.OK("%s ready: %s", label, doc.URL)
		return
	}
	if doc.ID != "" {
		log.OK("%s generating async (job %s)", label, doc.ID)
		return
	}
	log.OK("%s requested", label)
}
