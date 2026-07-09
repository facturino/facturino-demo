// Package config loads the demo's runtime configuration from the
// environment and builds a ready-to-use Facturino client.
//
// Every value comes from the environment so the same binary runs against
// the hosted API or a local emulator with no code change. See the
// repository .env.example for the full list of variables.
package config

import (
	"fmt"
	"os"
	"strings"

	facturino "github.com/facturino/facturino-go"
)

// Config holds the resolved settings the demo needs to run.
type Config struct {
	// APIKey is the secret API key. A test-mode key starts with
	// "fac_test_"; the demo refuses to run against a live key so it can
	// never mutate production data.
	APIKey string

	// BaseURL is the API base, e.g. https://facturino.com/api/v1. The SDK
	// already appends the /v1 version segment, so we hand it the API root
	// (.../api) and let it build the rest. See normalizeBaseURL.
	BaseURL string

	// WebhookSecret is the endpoint signing secret (whsec_...) used to
	// verify inbound webhook signatures.
	WebhookSecret string

	// PublicBaseURL is the externally reachable origin where Facturino can
	// deliver webhooks (typically a tunnel URL in local development). The
	// scenario registers PublicBaseURL + "/webhooks" as the endpoint.
	PublicBaseURL string

	// Port is the local TCP port the HTTP server listens on.
	Port string
}

// IsTestMode reports whether the configured key is a sandbox key.
func (c *Config) IsTestMode() bool {
	return strings.HasPrefix(c.APIKey, "fac_test_")
}

// WebhookURL returns the public URL Facturino should call, or "" when no public
// base URL is configured — webhook registration is then skipped by the scenario.
func (c *Config) WebhookURL() string {
	if c.PublicBaseURL == "" {
		return ""
	}
	return strings.TrimRight(c.PublicBaseURL, "/") + "/webhooks"
}

// Load reads the configuration from the process environment and validates
// the required fields. It returns a descriptive error naming the missing
// variable rather than failing later with an opaque 401.
func Load() (*Config, error) {
	cfg := &Config{
		APIKey:        os.Getenv("FACTURINO_API_KEY"),
		BaseURL:       os.Getenv("FACTURINO_BASE_URL"),
		WebhookSecret: os.Getenv("FACTURINO_WEBHOOK_SECRET"),
		PublicBaseURL: os.Getenv("PUBLIC_BASE_URL"),
		Port:          os.Getenv("PORT"),
	}

	if cfg.APIKey == "" {
		return nil, fmt.Errorf("FACTURINO_API_KEY is required (use a fac_test_ key)")
	}
	if !strings.HasPrefix(cfg.APIKey, "fac_test_") && !strings.HasPrefix(cfg.APIKey, "fac_live_") {
		return nil, fmt.Errorf("FACTURINO_API_KEY must start with fac_test_ or fac_live_")
	}
	if cfg.Port == "" {
		cfg.Port = "4242"
	}
	if cfg.BaseURL == "" {
		// Matches the SDK default; the .env.example documents the override.
		cfg.BaseURL = "https://facturino.com/api/v1"
	}

	return cfg, nil
}

// NewClient builds a Facturino API client from the configuration.
//
// The SDK appends the API version segment ("/v1") itself, so we pass it
// the API root. normalizeBaseURL strips a trailing "/v1" if the operator
// configured the full versioned URL (as .env.example shows) to avoid a
// doubled "/v1/v1" path.
func (c *Config) NewClient() *facturino.Client {
	return facturino.New(
		c.APIKey,
		facturino.WithBaseURL(normalizeBaseURL(c.BaseURL)),
	)
}

// normalizeBaseURL trims a trailing slash and a trailing "/v1" so the
// value can be handed to the SDK, which re-adds the version segment.
func normalizeBaseURL(raw string) string {
	u := strings.TrimRight(raw, "/")
	u = strings.TrimSuffix(u, "/v1")
	return u
}
