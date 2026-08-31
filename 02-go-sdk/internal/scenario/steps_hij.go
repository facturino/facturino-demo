package scenario

import (
	"context"
	"fmt"

	facturino "github.com/facturino/facturino-go/v2"
)

// StepWebhooks covers phase H (the registration half): create the webhook
// endpoint pointing at this server's public /webhooks URL, list endpoints,
// fire a test delivery, then walk the event log and replay one event. The
// receiving half lives in the HTTP server (internal/server), which verifies
// the signature with the SDK helper.
//
//	webhookEndpoints.Create/List/Test, events.List/Get/Retry.
func (r *Runner) StepWebhooks(ctx context.Context) error {
	if r.WebhookURL == "" {
		r.log.Skip("webhooks: PUBLIC_BASE_URL not set, skipping endpoint registration")
	} else {
		r.log.Step("webhookEndpoints.Create %s", r.WebhookURL)
		we, err := r.client.WebhookEndpoints.Create(&facturino.WebhookEndpointParams{
			URL: r.WebhookURL,
			Events: []string{
				"invoice.finalized",
				"invoice.transmitted",
				"invoice.received",
				"invoice.paid",
				"quote.accepted",
				"credit_note.finalized",
			},
			Description:    "Atelier Dupont demo (Go) webhook receiver",
			IdempotencyKey: r.idemKey("webhook-endpoint"),
		})
		if err != nil {
			if isExpectedSkip(err) {
				r.log.Skip("webhookEndpoints.Create: %s", explain(err))
			} else {
				return err
			}
		} else {
			r.state.WebhookEndpointID = we.ID
			// The signing secret is only returned at creation. In a real
			// integration you would persist it to FACTURINO_WEBHOOK_SECRET.
			r.log.OK("endpoint %s (save secret to FACTURINO_WEBHOOK_SECRET to verify deliveries)", we.ID)
		}
	}

	r.runStep("webhookEndpoints.List", func() error {
		count := 0
		it := r.client.WebhookEndpoints.List(&facturino.ListParams{Limit: 25})
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d webhook endpoints", count)
		return nil
	})

	if r.state.WebhookEndpointID != "" {
		r.runStep("webhookEndpoints.Test (send test delivery)", func() error {
			_, err := r.client.WebhookEndpoints.Test(r.state.WebhookEndpointID)
			return err
		})
	}

	// H.21 — Event log: list, fetch one, replay it.
	var firstEventID string
	r.runStep("events.List", func() error {
		it := r.client.Events.List(&facturino.EventListParams{ListParams: facturino.ListParams{Limit: 10}})
		count := 0
		for it.Next() {
			if firstEventID == "" {
				firstEventID = it.Event().ID
			}
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d events", count)
		return nil
	})
	if firstEventID != "" {
		r.runStep("events.Get", func() error {
			ev, err := r.client.Events.Get(firstEventID)
			if err == nil {
				r.log.OK("event %s type=%s delivered=%t", ev.ID, ev.Type, ev.Delivered)
			}
			return err
		})
		r.runStep("events.Retry (replay delivery)", func() error {
			_, err := r.client.Events.Retry(firstEventID)
			return err
		})
	}

	return nil
}

// StepAccounting covers phase I: VAT and revenue reporting, FEC and invoice
// exports (async, polled via the export status endpoints), an e-reporting
// declaration and the archive list. Account-level RGPD export lives in phase J.
//
//	reporting.VAT/Revenue, exports.GenerateFEC/GetFECStatus/ExportInvoices/
//	GetExportStatus, ereporting.CreateDeclaration/List/Get/
//	SubmitDeclaration, archives.List/Get.
func (r *Runner) StepAccounting(ctx context.Context) error {
	periodStart := firstOfYear()
	periodEnd := today()

	// I.22 — Reporting.
	r.runStep("reporting.VAT", func() error {
		rep, err := r.client.Reporting.VAT(&facturino.VATReportParams{PeriodStart: periodStart, PeriodEnd: periodEnd})
		if err == nil {
			r.log.OK("VAT total_ht=%d total_vat=%d invoices=%d", rep.TotalHT, rep.TotalVAT, rep.InvoiceCount)
		}
		return err
	})
	r.runStep("reporting.Revenue (group by month)", func() error {
		rep, err := r.client.Reporting.Revenue(&facturino.RevenueReportParams{PeriodStart: periodStart, PeriodEnd: periodEnd, GroupBy: "month"})
		if err == nil && rep.Revenue != nil {
			r.log.OK("revenue net=%d invoices=%d", rep.Revenue.Net, rep.InvoiceCount)
		}
		return err
	})

	// I.23 — Exports (async): kick off, then poll status to completion.
	r.runStep("exports.GenerateFec + GetFecStatus", func() error {
		fec, err := r.client.Exports.GenerateFEC(&facturino.FECParams{PeriodStart: periodStart, PeriodEnd: periodEnd})
		if err != nil {
			return err
		}
		r.log.OK("FEC job %s status=%s", fec.ID, fec.Status)
		return r.pollExport(ctx, "FEC", func() (string, string, error) {
			st, err := r.client.Exports.GetFECStatus(fec.ID)
			if err != nil {
				return "", "", err
			}
			return st.Status, st.DownloadURL, nil
		})
	})
	r.runStep("exports.ExportInvoices", func() error {
		exp, err := r.client.Exports.ExportInvoices(&facturino.InvoiceExportParams{PeriodStart: periodStart, PeriodEnd: periodEnd})
		if err != nil {
			return err
		}
		r.log.OK("invoice export job %s status=%s", exp.ID, exp.Status)
		return r.pollExport(ctx, "invoices", func() (string, string, error) {
			st, err := r.client.Exports.GetExportStatus(exp.ID)
			if err != nil {
				return "", "", err
			}
			return st.Status, st.DownloadURL, nil
		})
	})
	// RGPD (article 20) data export is account-level — covered in phase J via
	// account.RequestExport + account.DownloadExport.

	// I.24 — E-reporting declaration (B2C / international transactions).
	var declarationID string
	r.runStep("ereporting.CreateDeclaration", func() error {
		decl, err := r.client.EReporting.CreateDeclaration(&facturino.EReportingParams{
			Type:   "b2c",
			Period: currentMonth(),
			Lines: []*facturino.EReportingLineParams{
				{Category: "b2c_sales", Amount: 250000, VATRate: 2000, VATAmount: 50000},
			},
			IdempotencyKey: r.idemKey("ereporting"),
		})
		if err == nil {
			declarationID = decl.ID
			r.log.OK("declaration %s status=%s", decl.ID, decl.Status)
		}
		return err
	})
	r.runStep("ereporting.List", func() error {
		it := r.client.EReporting.List(&facturino.ListParams{Limit: 10})
		count := 0
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d declarations", count)
		return nil
	})
	if declarationID != "" {
		r.runStep("ereporting.Get", func() error {
			_, err := r.client.EReporting.Get(declarationID)
			return err
		})
		r.runStep("ereporting.SubmitDeclaration", func() error {
			_, err := r.client.EReporting.SubmitDeclaration(declarationID)
			return err
		})
	}

	// I.25 — Archives (PDF/A-3 + XML hash chain).
	r.runStep("archives.List", func() error {
		it := r.client.Archives.List(&facturino.ListParams{Limit: 10})
		count := 0
		var firstInvoice string
		for it.Next() {
			if firstInvoice == "" {
				firstInvoice = it.Archive().InvoiceID
			}
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d archives", count)
		if firstInvoice != "" {
			if _, err := r.client.Archives.Get(firstInvoice); err != nil {
				return err
			}
			r.log.OK("archives.Get %s", firstInvoice)
		}
		return nil
	})

	return nil
}

// StepAdministration covers phase J: the platform (Facturino) billing
// surface and the RGPD account data export. Both are read / request-only.
//
//	billing.RetrieveSubscription/ListInvoices/GetInvoicePdf,
//	account.RequestExport/DownloadExport.
func (r *Runner) StepAdministration(ctx context.Context) error {
	// J.29 — Platform billing (Facturino's own subscription to the account).
	r.runStep("billing.RetrieveSubscription", func() error {
		sub, err := r.client.Billing.RetrieveSubscription()
		if err == nil {
			r.log.OK("plan=%s cycle=%s status=%s", sub.Plan, sub.Cycle, sub.Status)
		}
		return err
	})
	r.runStep("billing.ListInvoices", func() error {
		list, err := r.client.Billing.ListInvoices(&facturino.ListParams{Limit: 10})
		if err != nil {
			return err
		}
		r.log.OK("%d platform invoices", len(list.Data))
		if len(list.Data) > 0 {
			if _, err := r.client.Billing.GetInvoicePDF(list.Data[0].ID); err != nil {
				return err
			}
			r.log.OK("billing.GetInvoicePdf %s", list.Data[0].ID)
		}
		return nil
	})

	// J.30 — RGPD: request a data export and download it once ready.
	r.runStep("account.RequestExport + DownloadExport", func() error {
		exp, err := r.client.Account.RequestExport()
		if err != nil {
			return err
		}
		r.log.OK("export %s status=%s", exp.ExportID, exp.Status)
		// The signed URL is only ready once the async export completes; the
		// download call is shown but tolerated-skipped while still pending.
		if _, derr := r.client.Account.DownloadExport(exp.ExportID); derr != nil && !isExpectedSkip(derr) {
			r.log.Warnf("account.DownloadExport not ready yet: %s", explain(derr))
		}
		return nil
	})

	return nil
}

// firstOfYear returns Jan 1 of the current year (YYYY-01-01).
func firstOfYear() string {
	return fmt.Sprintf("%04d-01-01", nowYear())
}

// currentMonth returns the current month as YYYY-MM (e-reporting period).
func currentMonth() string {
	return nowYearMonth()
}
