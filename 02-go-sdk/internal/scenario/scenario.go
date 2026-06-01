// Package scenario runs the shared "Atelier Dupont" storyline against the
// Facturino API using the Go SDK.
//
// The storyline is described in docs/SCENARIO.md at the repository root.
// Each exported Step* method maps to one lettered phase (A through J) and
// is safe to re-run: lookups happen before creates, and idempotency keys
// are derived deterministically from a per-run seed so a retried HTTP call
// reuses the same server-side resource instead of duplicating it.
//
// Conventions used throughout (see CONVENTIONS in SCENARIO.md):
//   - Amounts are integer centimes: 10000 == 100.00 EUR.
//   - VAT rates are integer centipercent: 2000 == 20.00 %.
//   - POST creations carry an Idempotency-Key.
//   - Lists are walked with the SDK's cursor iterators.
//   - Errors surface the request_id so failures are traceable in support.
package scenario

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	facturino "github.com/facturino/facturino-go"
)

// Runner carries the SDK client plus the state accumulated as the scenario
// progresses (the active company, the created customer, the finalized
// invoice, and so on). A single Runner drives the whole A->J parcours.
type Runner struct {
	client *facturino.Client
	log    *Logger

	// seed makes idempotency keys deterministic within a single run while
	// differing between runs, so re-invoking a route mid-run is safe but a
	// fresh run starts clean state on the server.
	seed string

	// allowDestructive gates operations that would alter a real account or
	// incur a real charge (Stripe checkout, account deletion, member
	// revoke, billing plan change). Off by default; see SCENARIO.md.
	allowDestructive bool

	// WebhookURL is the public endpoint the scenario registers in phase H.
	WebhookURL string

	// Accumulated state. Pointers are nil until the producing step runs.
	state State
}

// State is the mutable scratchpad threaded through the scenario steps. It
// is exported so the HTTP server can surface a JSON snapshot of progress.
type State struct {
	CompanyID             string `json:"company_id,omitempty"`
	SubscriptionProductID string `json:"subscription_product_id,omitempty"`
	OneOffProductID       string `json:"one_off_product_id,omitempty"`
	CustomerID            string `json:"customer_id,omitempty"`
	QuoteID               string `json:"quote_id,omitempty"`
	InvoiceID             string `json:"invoice_id,omitempty"`
	InvoiceNumber         string `json:"invoice_number,omitempty"`
	RecurringID           string `json:"recurring_id,omitempty"`
	CreditNoteID          string `json:"credit_note_id,omitempty"`
	ReceivedInvoiceID     string `json:"received_invoice_id,omitempty"`
	WebhookEndpointID     string `json:"webhook_endpoint_id,omitempty"`
	WorkerAPIKeyID        string `json:"worker_api_key_id,omitempty"`
}

// NewRunner builds a scenario runner. seed is mixed into idempotency keys;
// pass a stable value (for example time.Now().Format) per logical run.
func NewRunner(client *facturino.Client, log *Logger, seed string, allowDestructive bool, webhookURL string) *Runner {
	return &Runner{
		client:           client,
		log:              log,
		seed:             seed,
		allowDestructive: allowDestructive,
		WebhookURL:       webhookURL,
	}
}

// Snapshot returns a copy of the current accumulated state.
func (r *Runner) Snapshot() State { return r.state }

// idemKey derives a deterministic Idempotency-Key for a logical operation.
// The same (seed, op) pair always yields the same key, so a retried request
// within a run is de-duplicated server-side; a new run (new seed) is not.
func (r *Runner) idemKey(op string) string {
	return fmt.Sprintf("go-demo-%s-%s", r.seed, op)
}

// explain renders an SDK error for humans, pulling out the request_id and
// the API error code so a failing call can be looked up in support tooling.
// It is the single place the demo formats Facturino errors.
func explain(err error) string {
	if err == nil {
		return ""
	}
	var apiErr *facturino.Error
	if errors.As(err, &apiErr) {
		var b strings.Builder
		fmt.Fprintf(&b, "%s (type=%s, code=%s", apiErr.Message, apiErr.Type, apiErr.Code)
		if apiErr.Param != "" {
			fmt.Fprintf(&b, ", param=%s", apiErr.Param)
		}
		if apiErr.RequestID != "" {
			fmt.Fprintf(&b, ", request_id=%s", apiErr.RequestID)
		}
		if apiErr.Hint != "" {
			fmt.Fprintf(&b, ", hint=%q", apiErr.Hint)
		}
		b.WriteString(")")
		return b.String()
	}
	return err.Error()
}

// today returns today's date in the YYYY-MM-DD form the API expects for
// date-only fields (issued/due/period bounds).
func today() string { return time.Now().UTC().Format("2006-01-02") }

// inDays returns the date n days from now in YYYY-MM-DD form.
func inDays(n int) string { return time.Now().UTC().AddDate(0, 0, n).Format("2006-01-02") }

// firstOfNextMonth returns the first day of next month (recurrence start).
func firstOfNextMonth() string {
	now := time.Now().UTC()
	first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1, 0)
	return first.Format("2006-01-02")
}

// nowYear returns the current UTC year.
func nowYear() int { return time.Now().UTC().Year() }

// nowYearMonth returns the current UTC month as YYYY-MM.
func nowYearMonth() string { return time.Now().UTC().Format("2006-01") }

// pollExport polls an export status callback until the export reports a
// terminal state or the context is cancelled. status returns the current
// status string, the download URL when ready, and any transport error.
func (r *Runner) pollExport(ctx context.Context, label string, status func() (string, string, error)) error {
	const maxAttempts = 10
	for attempt := 0; attempt < maxAttempts; attempt++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		st, downloadURL, err := status()
		if err != nil {
			return err
		}
		switch st {
		case "completed", "succeeded", "ready", "done":
			r.log.OK("%s export ready: %s", label, downloadURL)
			return nil
		case "failed", "error":
			return fmt.Errorf("%s export failed", label)
		}
		sleepCtx(ctx, attempt)
	}
	r.log.Infof("%s export still pending after %d polls (continuing)", label, maxAttempts)
	return nil
}

// RunAll executes the entire A->J parcours in order, stopping at the first
// hard failure. Non-fatal, plan-gated or environment-dependent operations
// are reported as skips and do not abort the run (see runStep).
func (r *Runner) RunAll(ctx context.Context) error {
	steps := []struct {
		name string
		fn   func(context.Context) error
	}{
		{"A. Bootstrap account", r.StepBootstrap},
		{"B. Catalogue & customer", r.StepCatalogueAndCustomer},
		{"C. Quote -> invoice", r.StepQuoteToInvoice},
		{"D. Invoice lifecycle", r.StepInvoiceLifecycle},
		{"E. Recurring subscription", r.StepRecurring},
		{"F. Credit note", r.StepCreditNote},
		{"G. Received (purchase) invoices", r.StepReceivedInvoices},
		{"H. Webhooks", r.StepWebhooks},
		{"I. Accounting & reporting", r.StepAccounting},
		{"J. Account administration", r.StepAdministration},
	}
	for _, s := range steps {
		r.log.Phase(s.name)
		if err := s.fn(ctx); err != nil {
			r.log.Errorf("%s failed: %s", s.name, explain(err))
			return fmt.Errorf("%s: %w", s.name, err)
		}
	}
	r.log.Phase("Scenario complete")
	return nil
}

// runStep is a small helper for optional sub-operations: it logs the call,
// runs fn, and converts plan-gated / not-found / unsupported outcomes into a
// "skipped" log line instead of a fatal error. This keeps the parcours
// runnable on any plan while still exercising the call path.
func (r *Runner) runStep(label string, fn func() error) {
	r.log.Step(label)
	if err := fn(); err != nil {
		if isExpectedSkip(err) {
			r.log.Skip("%s: %s", label, explain(err))
			return
		}
		r.log.Warnf("%s: %s", label, explain(err))
	}
}

// isExpectedSkip reports whether an error is one the demo tolerates: a
// plan-gated feature, a missing optional resource, or a feature that needs
// a real PA / account that the sandbox cannot provide.
func isExpectedSkip(err error) bool {
	var apiErr *facturino.Error
	if errors.As(err, &apiErr) {
		switch apiErr.Type {
		case facturino.ErrorTypePlanLimit, facturino.ErrorTypeNotFound:
			return true
		}
		switch apiErr.HTTPStatusCode {
		case 402, 403, 404, 409, 501:
			return true
		}
	}
	return false
}

// sleepCtx waits a short, attempt-scaled delay, returning early if the
// context is cancelled. Used to space out async job polling.
func sleepCtx(ctx context.Context, attempt int) {
	delay := time.Duration(500+attempt*250) * time.Millisecond
	if delay > 3*time.Second {
		delay = 3 * time.Second
	}
	t := time.NewTimer(delay)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}
