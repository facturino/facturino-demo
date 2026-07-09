package scenario

import (
	"context"
	"fmt"

	facturino "github.com/facturino/facturino-go"
)

// StepRecurring covers phase E: the recurring monthly subscription that is
// the heart of the SaaS billing. It creates the schedule, reads it back,
// updates it, then pauses and resumes it.
//
//	recurringInvoices.Create/List/Get/Update/Pause/Resume.
func (r *Runner) StepRecurring(ctx context.Context) error {
	if r.state.CustomerID == "" {
		return fmt.Errorf("no customer in state; run phase B first")
	}

	r.log.Step("recurringInvoices.Create (monthly)")
	rec, err := r.client.RecurringInvoices.Create(&facturino.RecurringInvoiceParams{
		CustomerID:         r.state.CustomerID,
		Frequency:          "monthly",
		StartDate:          firstOfNextMonth(),
		NextGenerationDate: firstOfNextMonth(),
		TemplateInvoice: &facturino.RecurringTemplateParams{
			Items: []*facturino.ItemParams{
				{Description: "Abonnement Atelier Pro (mensuel)", Quantity: "1", Unit: "month", UnitPrice: 4900, VATRate: 2000, VATCode: "S", Product: r.state.SubscriptionProductID},
			},
			PaymentMethod:    "transfer",
			PaymentTermsDays: 30,
		},
		AutoFinalize:   true,
		AutoSend:       true,
		IdempotencyKey: r.idemKey("recurring"),
	})
	if err != nil {
		return err
	}
	r.state.RecurringID = rec.ID
	r.log.OK("recurring %s next=%s", rec.ID, rec.NextGenerationDate)

	r.runStep("recurringInvoices.Get", func() error {
		_, err := r.client.RecurringInvoices.Get(rec.ID)
		return err
	})
	r.runStep("recurringInvoices.List", func() error {
		count := 0
		it := r.client.RecurringInvoices.List(&facturino.ListParams{Limit: 25})
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d recurring schedules", count)
		return nil
	})
	r.runStep("recurringInvoices.Update (stop auto-send)", func() error {
		autoSend := false
		_, err := r.client.RecurringInvoices.Update(rec.ID, &facturino.RecurringInvoiceUpdateParams{
			AutoSend: &autoSend,
		})
		return err
	})
	r.runStep("recurringInvoices.Pause", func() error {
		_, err := r.client.RecurringInvoices.Pause(rec.ID)
		return err
	})
	r.runStep("recurringInvoices.Resume", func() error {
		_, err := r.client.RecurringInvoices.Resume(rec.ID)
		return err
	})

	return nil
}

// StepCreditNote covers phase F: a credit note correcting the finalized
// invoice (a partial commercial gesture), then finalize, deposit and fetch
// its documents.
//
//	creditNotes.Create/Finalize/Send/GetPdf/GetFacturx.
func (r *Runner) StepCreditNote(ctx context.Context) error {
	if r.state.InvoiceID == "" {
		r.log.Skip("credit note: no finalized invoice in state, skipping phase F")
		return nil
	}

	r.log.Step("creditNotes.Create (linked to invoice)")
	cn, err := r.client.CreditNotes.Create(&facturino.CreditNoteParams{
		Customer:         r.state.CustomerID,
		RelatedInvoiceID: r.state.InvoiceID,
		CreditNoteType:   "partial",
		ReasonCode:       "other",
		Reason:           "Geste commercial sur la prestation de mise en place.",
		Items: []*facturino.ItemParams{
			{Description: "Remise exceptionnelle", Quantity: "1", Unit: "flat_rate", UnitPrice: 5000, VATRate: 2000, VATCode: "S"},
		},
		Dates:          &facturino.CreditNoteDates{Issued: today()},
		IdempotencyKey: r.idemKey("credit-note"),
	})
	if err != nil {
		// A finalized credit note may already exist from a prior run; treat
		// plan/conflict/not-found as a soft skip so the phase keeps going.
		if isExpectedSkip(err) {
			r.log.Skip("creditNotes.Create: %s", explain(err))
			return nil
		}
		return err
	}
	r.state.CreditNoteID = cn.ID
	r.log.OK("credit note %s status=%s", cn.ID, cn.Status)

	r.runStep("creditNotes.Finalize", func() error {
		_, err := r.client.CreditNotes.Finalize(cn.ID)
		return err
	})
	r.runStep("creditNotes.Send (deposit to PA)", func() error {
		_, err := r.client.CreditNotes.Send(cn.ID)
		return err
	})
	r.runStep("creditNotes.GetPdf", func() error {
		doc, err := r.client.CreditNotes.GetPDF(cn.ID)
		if err == nil {
			logDocument(r.log, "credit note PDF", doc)
		}
		return err
	})
	r.runStep("creditNotes.GetFacturx", func() error {
		doc, err := r.client.CreditNotes.GetFacturX(cn.ID)
		if err == nil {
			logDocument(r.log, "credit note Factur-X", doc)
		}
		return err
	})

	// F.17 — Read the parent invoice back with the credit notes inlined
	// (expand=credit_notes), surfacing the linked avoirs and the net
	// balance (invoice total less the sum of its credit notes).
	r.runStep("invoices.Get (expand=credit_notes)", func() error {
		inv, err := r.client.Invoices.Get(r.state.InvoiceID, &facturino.InvoiceGetParams{
			Expand: []string{"credit_notes"},
		})
		if err != nil {
			return err
		}
		if inv.Expanded == nil {
			r.log.OK("no expanded payload returned")
			return nil
		}
		r.log.OK("%d linked credit notes, net_balance=%.2f", len(inv.Expanded.CreditNotes), float64(inv.Expanded.NetBalance)/100)
		return nil
	})

	return nil
}

// StepReceivedInvoices covers phase G: the purchase side. The SaaS also
// receives supplier invoices through the PA. The demo ingests one, lists
// the inbox, then drives its lifecycle (approve / record payment), and
// illustrates the refuse / suspend actions guarded so they only run when a
// distinct received invoice exists.
//
//	invoices.CreateIncoming/ListIncoming, receivedInvoices.List/Get/
//	Approve/Refuse/Suspend/RecordPayment.
func (r *Runner) StepReceivedInvoices(ctx context.Context) error {
	// G.18 — Ingest an incoming (supplier) invoice. In production these
	// arrive from the PA; here we seed one so the inbox is non-empty.
	r.runStep("invoices.CreateIncoming (supplier invoice)", func() error {
		inv, err := r.client.Invoices.CreateIncoming(&facturino.IncomingInvoiceParams{
			SenderName:     "Fournisseur Demo SARL",
			SenderSiret:    "40483304800022",
			Amount:         60000, // total incl. VAT, in integer cents
			Reference:      "F-SUP-2026-118",
			IdempotencyKey: r.idemKey("incoming"),
		})
		if err == nil {
			r.log.OK("incoming invoice %s", inv.ID)
		}
		return err
	})

	r.runStep("invoices.ListIncoming", func() error {
		count := 0
		it := r.client.Invoices.ListIncoming(&facturino.ListParams{Limit: 25})
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d incoming invoices", count)
		return nil
	})

	// G.18 — The PA-received inbox: list and capture the first id.
	r.runStep("receivedInvoices.List", func() error {
		it := r.client.ReceivedInvoices.List(&facturino.ListParams{Limit: 25})
		count := 0
		for it.Next() {
			if r.state.ReceivedInvoiceID == "" {
				r.state.ReceivedInvoiceID = it.ReceivedInvoice().ID
			}
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d received invoices", count)
		return nil
	})

	if r.state.ReceivedInvoiceID == "" {
		r.log.Skip("receivedInvoices.*: inbox empty (no PA-delivered invoice yet)")
		return nil
	}
	rid := r.state.ReceivedInvoiceID

	r.runStep("receivedInvoices.Get", func() error {
		_, err := r.client.ReceivedInvoices.Get(rid)
		return err
	})
	r.runStep("receivedInvoices.Approve", func() error {
		res, err := r.client.ReceivedInvoices.Approve(rid)
		if err == nil {
			r.log.OK("approved, status=%s", res.Status)
		}
		return err
	})
	r.runStep("receivedInvoices.RecordPayment", func() error {
		res, err := r.client.ReceivedInvoices.RecordPayment(rid, &facturino.RecordPaymentParams{
			Amount:    14400, // 120,00 HT -> 144,00 TTC
			Method:    "transfer",
			Reference: "VIR-FOURN-0001",
			PaidAt:    today(),
		})
		if err == nil {
			r.log.OK("payment recorded, reconciled=%t", res.Reconciled)
		}
		return err
	})

	// Refuse and Suspend are alternative lifecycle branches. Approving and
	// refusing the same invoice is contradictory, so the demo only
	// documents the call shapes here and leaves them gated; flip the guard
	// when you have a second received invoice to act on.
	const demonstrateRejectBranches = false
	if demonstrateRejectBranches {
		r.runStep("receivedInvoices.Suspend", func() error {
			_, err := r.client.ReceivedInvoices.Suspend(rid)
			return err
		})
		r.runStep("receivedInvoices.Refuse", func() error {
			_, err := r.client.ReceivedInvoices.Refuse(rid, &facturino.RefuseParams{Reason: "Montant non conforme au bon de commande."})
			return err
		})
	} else {
		r.log.Skip("receivedInvoices.Refuse/Suspend: gated (alternative branch to Approve)")
	}

	return nil
}
