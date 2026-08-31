// Package server exposes the demo over HTTP: a handful of routes trigger
// the scenario phases, and POST /webhooks receives Facturino events with a
// verified signature.
//
// The scenario calls are serialized behind a mutex because they share one
// Runner whose accumulated state (created customer, finalized invoice, ...)
// is threaded across phases. This keeps a fired-twice request from racing
// on that state; it is not a throughput-oriented design.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	facturino "github.com/facturino/facturino-go/v2"

	"github.com/facturino/facturino-demo/go-sdk/internal/config"
	"github.com/facturino/facturino-demo/go-sdk/internal/scenario"
)

// Server wires the HTTP routes to a scenario Runner and the webhook
// verifier.
type Server struct {
	cfg    *config.Config
	runner *scenario.Runner
	log    *scenario.Logger

	mu sync.Mutex // serializes scenario runs sharing the Runner's state
}

// New builds a Server.
func New(cfg *config.Config, runner *scenario.Runner, log *scenario.Logger) *Server {
	return &Server{cfg: cfg, runner: runner, log: log}
}

// Handler returns the demo's HTTP routing tree built on the standard
// library mux. Phase routes map 1:1 to the scenario's lettered steps.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/state", s.handleState)

	// Full workflow.
	mux.HandleFunc("/run", s.requirePost(s.handleRunAll))

	// Per-phase routes (A..K). Each runs one StepXxx in scenario order.
	mux.HandleFunc("/run/bootstrap", s.requirePost(s.phase(s.runner.StepBootstrap)))
	mux.HandleFunc("/run/catalogue", s.requirePost(s.phase(s.runner.StepCatalogueAndCustomer)))
	mux.HandleFunc("/run/quote", s.requirePost(s.phase(s.runner.StepQuoteToInvoice)))
	mux.HandleFunc("/run/invoice", s.requirePost(s.phase(s.runner.StepInvoiceLifecycle)))
	mux.HandleFunc("/run/recurring", s.requirePost(s.phase(s.runner.StepRecurring)))
	mux.HandleFunc("/run/tax-decision", s.requirePost(s.phase(s.runner.StepTaxDecision)))
	mux.HandleFunc("/run/decided-credit-note", s.requirePost(s.phase(s.runner.StepDecidedCreditNote)))
	mux.HandleFunc("/run/decided-recurring", s.requirePost(s.phase(s.runner.StepDecidedRecurring)))
	mux.HandleFunc("/run/deposit-schedule", s.requirePost(s.phase(s.runner.StepDepositAndSchedule)))
	mux.HandleFunc("/run/integration-decision", s.requirePost(s.phase(s.runner.StepIntegrationDecision)))
	mux.HandleFunc("/run/credit-note", s.requirePost(s.phase(s.runner.StepCreditNote)))
	mux.HandleFunc("/run/received", s.requirePost(s.phase(s.runner.StepReceivedInvoices)))
	mux.HandleFunc("/run/webhooks", s.requirePost(s.phase(s.runner.StepWebhooks)))
	mux.HandleFunc("/run/accounting", s.requirePost(s.phase(s.runner.StepAccounting)))
	mux.HandleFunc("/run/administration", s.requirePost(s.phase(s.runner.StepAdministration)))

	// Webhook receiver (phase H, reception half).
	mux.HandleFunc("/webhooks", s.requirePost(s.handleWebhook))

	return mux
}

// requirePost rejects non-POST methods so the trigger routes are not fired
// by a stray browser GET.
func (s *Server) requirePost(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
			return
		}
		next(w, r)
	}
}

// phase adapts a single scenario step into an HTTP handler, serializing on
// the shared Runner and reporting the resulting state snapshot.
func (s *Server) phase(step func(context.Context) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()

		// Bound the work so a slow upstream cannot hang the request forever.
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()

		if err := step(ctx); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"ok":    false,
				"error": err.Error(),
				"state": s.runner.Snapshot(),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": s.runner.Snapshot()})
	}
}

func (s *Server) handleRunAll(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	if err := s.runner.RunAll(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok":    false,
			"error": err.Error(),
			"state": s.runner.Snapshot(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": s.runner.Snapshot()})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.runner.Snapshot())
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":      "facturino-demo (Go)",
		"scenario":  "Atelier Dupont — full A..K workflow",
		"test_mode": s.cfg.IsTestMode(),
		"routes": map[string]string{
			"POST /run":                      "run the full scenario A..J",
			"POST /run/bootstrap":            "A — account, company, usage",
			"POST /run/catalogue":            "B — products + customer",
			"POST /run/quote":                "C — quote -> draft invoice + validate",
			"POST /run/invoice":              "D — finalize, documents, PA, payment, audit",
			"POST /run/recurring":            "E — monthly subscription schedule",
			"POST /run/integration-decision": "K — VAT supplied by the integration",
			"POST /run/credit-note":          "F — credit note",
			"POST /run/received":             "G — supplier/received invoices",
			"POST /run/webhooks":             "H — register endpoint + events",
			"POST /run/accounting":           "I — reporting, exports, e-reporting, archives",
			"POST /run/administration":       "J — billing, RGPD",
			"POST /webhooks":                 "receive a signed Facturino event",
			"GET /state":                     "current scenario state snapshot",
			"GET /healthz":                   "liveness probe",
		},
	})
}

// handleWebhook is the reception half of phase H. It reads the RAW request
// body (before any JSON parsing), verifies the HMAC-SHA256 signature with
// the SDK helper VerifyWebhookSignature, and dispatches on the event type.
//
// Verifying against the raw bytes is essential: re-serializing the parsed
// JSON would change the byte sequence and break the signature.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // cap at 1 MiB
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot read body"})
		return
	}

	sigHeader := r.Header.Get("Facturino-Signature")

	if s.cfg.WebhookSecret == "" {
		// Without a secret we cannot trust the payload. Refuse rather than
		// process an unverified event.
		s.log.Warnf("webhook received but FACTURINO_WEBHOOK_SECRET is unset — rejecting")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "webhook secret not configured"})
		return
	}

	// SDK helper: parses t=/v1= header, checks the timestamp tolerance,
	// recomputes the HMAC over "<timestamp>.<rawBody>" and timing-safe
	// compares it, then unmarshals the verified envelope.
	event, err := facturino.VerifyWebhookSignature(body, sigHeader, s.cfg.WebhookSecret)
	if err != nil {
		s.log.Warnf("webhook signature rejected: %s", err)
		// 400 tells Facturino the delivery was malformed/forged; it will not
		// keep retrying a signature it cannot satisfy.
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid signature"})
		return
	}

	s.dispatch(event)

	// Acknowledge quickly with 2xx so Facturino marks the delivery
	// successful. Heavy processing should be queued, not done inline.
	writeJSON(w, http.StatusOK, map[string]string{"received": event.ID})
}

// dispatch routes a verified event to its handler. Real integrations would
// update their own database here; the demo logs the salient fields.
func (s *Server) dispatch(event *facturino.WebhookEvent) {
	object := objectID(event.Data)
	s.log.Infof("webhook %s type=%s livemode=%t object=%s", event.ID, event.Type, event.Livemode, object)

	switch {
	case event.Type == "invoice.finalized":
		s.log.Infof("  -> invoice %s finalized: persist the legal number", object)
	case event.Type == "invoice.transmitted":
		s.log.Infof("  -> invoice %s transmitted to the PA", object)
	case event.Type == "invoice.received":
		s.log.Infof("  -> invoice %s acknowledged by the recipient", object)
	case event.Type == "invoice.paid":
		s.log.Infof("  -> invoice %s paid: mark the order fulfilled", object)
	case event.Type == "quote.accepted":
		s.log.Infof("  -> quote %s accepted: convert to an invoice", object)
	case strings.HasPrefix(event.Type, "credit_note."):
		s.log.Infof("  -> credit note event %s", event.Type)
	default:
		s.log.Infof("  -> no specific handler for %s (ignored)", event.Type)
	}
}

// objectID extracts data.object.id from the event envelope, tolerating the
// loosely-typed map the SDK decodes the body into.
func objectID(data map[string]any) string {
	if data == nil {
		return ""
	}
	obj, ok := data["object"].(map[string]any)
	if !ok {
		return ""
	}
	if id, ok := obj["id"].(string); ok {
		return id
	}
	return ""
}

// writeJSON writes v as an indented JSON response with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		// The header is already written; nothing actionable remains but to
		// surface it in the server log.
		fmt.Printf("writeJSON: %v\n", err)
	}
}
