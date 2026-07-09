// Command facturino-demo runs the "Atelier Dupont" scenario against the
// Facturino API with the Go SDK.
//
// Two modes:
//
//	./facturino-demo            start the HTTP server (routes + /webhooks)
//	./facturino-demo -run       run the full A..J parcours once and exit
//
// Configuration comes from the environment (see the repository
// .env.example). A test-mode API key (fac_test_) is required; the demo
// refuses to run against a live key.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/facturino/facturino-demo/go-sdk/internal/config"
	"github.com/facturino/facturino-demo/go-sdk/internal/scenario"
	"github.com/facturino/facturino-demo/go-sdk/internal/server"
)

func main() {
	var (
		runOnce = flag.Bool("run", false, "run the full scenario once, then exit (no server)")
		envFile = flag.String("env", "", "optional path to a .env file to load before reading config")
	)
	flag.Parse()

	if *envFile != "" {
		if err := loadDotEnv(*envFile); err != nil {
			log.Fatalf("load env file %s: %v", *envFile, err)
		}
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	logger := scenario.NewLogger(log.New(os.Stdout, "", log.LstdFlags))
	client := cfg.NewClient()

	// A per-process seed keeps idempotency keys stable across retries within
	// this run while differing from previous runs.
	seed := time.Now().UTC().Format("20060102-150405")
	runner := scenario.NewRunner(client, logger, seed, cfg.WebhookURL())

	if *runOnce {
		ctx, cancel := signalContext()
		defer cancel()
		if err := runner.RunAll(ctx); err != nil {
			log.Fatalf("scenario failed: %v", err)
		}
		return
	}

	srv := server.New(cfg, runner, logger)
	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, cancel := signalContext()
	defer cancel()

	go func() {
		log.Printf("facturino-demo (Go) listening on :%s (test_mode=%t)", cfg.Port, cfg.IsTestMode())
		log.Printf("webhook receiver: POST %s", cfg.WebhookURL())
		log.Printf("trigger the scenario: curl -X POST http://localhost:%s/run", cfg.Port)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}

// signalContext returns a context cancelled on SIGINT or SIGTERM.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}
