package scenario

import (
	"context"
	"fmt"

	facturino "github.com/facturino/facturino-go"
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

// StepAccounting covers phase I: VAT and revenue reporting, FEC / invoice /
// RGPD exports (async, polled via the export status endpoints), an
// e-reporting declaration, the archive list and the in-app notification
// feed plus per-event notification preferences.
//
//	reporting.VAT/Revenue, exports.GenerateFEC/GetFECStatus/ExportInvoices/
//	ExportRGPD/GetExportStatus, ereporting.CreateDeclaration/List/Get/
//	SubmitDeclaration, archives.List/Get, notifications.List/MarkRead/
//	MarkAllRead/RetrievePreferences/UpdatePreferences.
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
		exp, err := r.client.Exports.ExportInvoices()
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
	r.runStep("exports.ExportRgpd + GetExportStatus", func() error {
		exp, err := r.client.Exports.ExportRGPD()
		if err != nil {
			return err
		}
		r.log.OK("RGPD export job %s status=%s", exp.ID, exp.Status)
		return r.pollExport(ctx, "RGPD", func() (string, string, error) {
			st, err := r.client.Exports.GetExportStatus(exp.ID)
			if err != nil {
				return "", "", err
			}
			return st.Status, st.DownloadURL, nil
		})
	})

	// I.24 — E-reporting declaration (B2C / international transactions).
	var declarationID string
	r.runStep("ereporting.CreateDeclaration", func() error {
		decl, err := r.client.EReporting.CreateDeclaration(&facturino.EReportingParams{
			Type:   "transactions",
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

	// I.26 — Product notifications: feed + preferences.
	r.runStep("notifications.List", func() error {
		unread := true
		list, err := r.client.Notifications.List(&facturino.NotificationListParams{Limit: 10, Unread: &unread})
		if err != nil {
			return err
		}
		r.log.OK("%d unread notifications", len(list.Data))
		if len(list.Data) > 0 {
			if _, err := r.client.Notifications.MarkRead(list.Data[0].ID); err != nil {
				return err
			}
			r.log.OK("notifications.MarkRead %s", list.Data[0].ID)
		}
		return nil
	})
	r.runStep("notifications.MarkAllRead", func() error {
		b, err := r.client.Notifications.MarkAllRead()
		if err == nil {
			r.log.OK("marked %d read", b.Updated)
		}
		return err
	})
	r.runStep("notifications.RetrievePreferences", func() error {
		_, err := r.client.Notifications.RetrievePreferences()
		return err
	})
	r.runStep("notifications.UpdatePreferences", func() error {
		on := true
		_, err := r.client.Notifications.UpdatePreferences(&facturino.NotificationPreferencesUpdate{
			Preferences: map[string]facturino.NotificationChannelToggles{
				"invoice_paid": {Email: &on, InApp: &on},
			},
		})
		return err
	})

	return nil
}

// StepAdministration covers phase J: API keys for a restricted worker,
// team members, the platform (Facturino) billing surface, and RGPD account
// operations. Destructive or charge-incurring calls (member revoke, plan
// change, billing checkout/portal/pause, account deletion) are gated behind
// allowDestructive and otherwise only documented.
//
//	apiKeys.Create/List/Get/Roll/Revoke, members.Invite/List/Get/
//	UpdateRole/ResendInvitation/Revoke, billing.RetrieveSubscription/
//	ListInvoices/GetInvoicePdf/UpdateSubscription/Pause/Resume/Checkout/
//	Portal, account.RequestExport/DownloadExport/UpdateNotifications
//	(+ ScheduleDeletion/CancelDeletion documented), cabinets.List
//	(illustrative).
func (r *Runner) StepAdministration(ctx context.Context) error {
	// J.27 — A scoped API key for a background worker (read invoices only).
	r.runStep("apiKeys.Create (worker, restricted scope)", func() error {
		key, err := r.client.APIKeys.Create(&facturino.APIKeyParams{
			Name:           "Atelier Dupont worker (read-only)",
			Livemode:       false,
			Permissions:    []string{"invoices:read", "customers:read"},
			IdempotencyKey: r.idemKey("worker-key"),
		})
		if err == nil {
			r.state.WorkerAPIKeyID = key.ID
			// key.Key is only present here, at creation.
			r.log.OK("api key %s (prefix %s) — secret shown once", key.ID, key.Prefix)
		}
		return err
	})
	r.runStep("apiKeys.List", func() error {
		it := r.client.APIKeys.List(&facturino.ListParams{Limit: 25})
		count := 0
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d api keys", count)
		return nil
	})
	if r.state.WorkerAPIKeyID != "" {
		r.runStep("apiKeys.Get", func() error {
			_, err := r.client.APIKeys.Get(r.state.WorkerAPIKeyID)
			return err
		})
		r.runStep("apiKeys.Roll (rotate secret)", func() error {
			_, err := r.client.APIKeys.Roll(r.state.WorkerAPIKeyID)
			return err
		})
		// Revoking the worker key is safe (it is the demo's own throwaway
		// key, never the running key), so we do it to complete the cycle.
		r.runStep("apiKeys.Revoke (cleanup worker key)", func() error {
			return r.client.APIKeys.Revoke(r.state.WorkerAPIKeyID)
		})
	}

	// J.28 — Members. Invite + list + read are safe; role change / revoke
	// touch real collaborators, so they are gated.
	companyID := r.state.CompanyID
	var memberID string
	if companyID != "" {
		r.runStep("members.Invite (accountant)", func() error {
			m, err := r.client.Members.Invite(&facturino.MemberInviteParams{
				CompanyID:      companyID,
				Email:          "comptable@atelier-dupont.example",
				Role:           "accountant",
				IdempotencyKey: r.idemKey("member-invite"),
			})
			if err == nil {
				memberID = m.ID
				r.log.OK("invited member %s status=%s", m.ID, m.Status)
			}
			return err
		})
		r.runStep("members.List", func() error {
			it := r.client.Members.List(companyID, &facturino.ListParams{Limit: 25})
			count := 0
			for it.Next() {
				if memberID == "" {
					memberID = it.Member().ID
				}
				count++
			}
			if err := it.Err(); err != nil {
				return err
			}
			r.log.OK("%d members", count)
			return nil
		})
		if memberID != "" {
			r.runStep("members.Get", func() error {
				_, err := r.client.Members.Get(companyID, memberID)
				return err
			})
			r.runStep("members.ResendInvitation", func() error {
				_, err := r.client.Members.ResendInvitation(companyID, memberID)
				return err
			})
			if r.allowDestructive {
				r.runStep("members.UpdateRole -> viewer", func() error {
					_, err := r.client.Members.UpdateRole(companyID, memberID, &facturino.MemberUpdateRoleParams{Role: "viewer"})
					return err
				})
				r.runStep("members.Revoke", func() error {
					return r.client.Members.Revoke(companyID, memberID)
				})
			} else {
				r.log.Skip("members.UpdateRole/Revoke: gated (set allowDestructive to run)")
			}
		}
	}

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
	if r.allowDestructive {
		r.runStep("billing.UpdateSubscription (switch to annual)", func() error {
			annual := true
			_, err := r.client.Billing.UpdateSubscription(&facturino.BillingSubscriptionUpdateParams{Annual: &annual})
			return err
		})
		r.runStep("billing.Pause (1 month)", func() error {
			_, err := r.client.Billing.Pause(&facturino.BillingPauseParams{Months: 1})
			return err
		})
		r.runStep("billing.Resume", func() error {
			_, err := r.client.Billing.Resume()
			return err
		})
		r.runStep("billing.Checkout (Stripe session)", func() error {
			res, err := r.client.Billing.Checkout(&facturino.BillingCheckoutParams{
				PlanID:     "pro",
				SuccessURL: "https://atelier-dupont.example/billing/ok",
				CancelURL:  "https://atelier-dupont.example/billing/ko",
			})
			if err == nil {
				r.log.OK("checkout url=%s", res.URL)
			}
			return err
		})
		r.runStep("billing.Portal (Stripe customer portal)", func() error {
			res, err := r.client.Billing.Portal(&facturino.BillingPortalParams{ReturnURL: "https://atelier-dupont.example/billing"})
			if err == nil {
				r.log.OK("portal url=%s", res.URL)
			}
			return err
		})
	} else {
		r.log.Skip("billing.UpdateSubscription/Pause/Resume/Checkout/Portal: gated (would change plan / open Stripe)")
	}

	// J.30 — RGPD: request a data export and update notification flags.
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
	r.runStep("account.UpdateNotifications", func() error {
		on := true
		_, err := r.client.Account.UpdateNotifications(&facturino.AccountNotificationPreferencesUpdate{
			InvoicePaid:    &on,
			InvoiceOverdue: &on,
		})
		return err
	})

	// account.ScheduleDeletion / CancelDeletion are intentionally NOT run:
	// scheduling a deletion would put the whole account into a 30-day
	// teardown. They are gated behind allowDestructive AND require an
	// explicit opt-in beyond it, so they stay documented-only here.
	if r.allowDestructive {
		r.log.Skip("account.ScheduleDeletion/CancelDeletion: documented only, never auto-run")
	}

	// Cabinets: experts-comptables surface. Requires a cabinet_* plan; a
	// single illustrative list call (tolerated-skipped on lower plans).
	r.runStep("cabinets.List (illustrative, cabinet_* plan)", func() error {
		list, err := r.client.Cabinets.List(&facturino.ListParams{Limit: 5})
		if err == nil {
			r.log.OK("%d cabinets", len(list.Data))
		}
		return err
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
