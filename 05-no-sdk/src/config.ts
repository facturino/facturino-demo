/**
 * Configuration — everything comes from the environment.
 *
 * The shape mirrors `.env.example` at the repo root. There is no dotenv
 * dependency on purpose (zero runtime deps): load the file yourself with
 * `node --env-file=.env dist/server.js`, or export the variables in your
 * shell. The loader below only *reads* `process.env`.
 */

/** Fully resolved configuration for the demo. */
export interface Config {
  /** Test-mode API key, `fac_test_…`. Sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** API base URL, e.g. `https://facturino.com/api/v1` (no trailing slash). */
  baseUrl: string;
  /** Endpoint signing secret, `whsec_…`. Verifies inbound webhook signatures. */
  webhookSecret: string;
  /** Public HTTPS URL Facturino can reach to deliver webhooks to this server. */
  publicBaseUrl: string;
  /** Local TCP port the demo HTTP server listens on. */
  port: number;
  /** `true` when the API key is live mode (`fac_live_`). The demo refuses it. */
  livemode: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy ../.env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Build the {@link Config} from `process.env`, validating the essentials.
 *
 * Throws early (before the server binds a port) if the API key is malformed
 * or live-mode — the demos must never touch production data.
 */
export function loadConfig(): Config {
  const apiKey = required('FACTURINO_API_KEY');

  if (!apiKey.startsWith('fac_test_') && !apiKey.startsWith('fac_live_')) {
    throw new Error(
      'FACTURINO_API_KEY must start with fac_test_ or fac_live_. ' +
        'Get a test key from the Facturino dashboard (Developers → API keys).',
    );
  }

  const livemode = apiKey.startsWith('fac_live_');
  if (livemode) {
    throw new Error(
      'Refusing to run with a LIVE key (fac_live_…). ' +
        'This demo is destructive-by-example and must only run in test mode. ' +
        'Use a fac_test_ key.',
    );
  }

  // Strip any trailing slash so we can safely join paths with `${baseUrl}${path}`.
  const baseUrl = optional('FACTURINO_BASE_URL', 'https://facturino.com/api/v1').replace(
    /\/+$/,
    '',
  );

  return {
    apiKey,
    baseUrl,
    // Optional: the signing secret only exists AFTER webhookEndpoints.create runs
    // (chicken-and-egg at first boot). Empty until then; the /webhook handler
    // rejects unsigned/unknown-secret deliveries.
    webhookSecret: optional('FACTURINO_WEBHOOK_SECRET', ''),
    publicBaseUrl: optional('PUBLIC_BASE_URL', '').replace(/\/+$/, ''),
    port: Number.parseInt(optional('PORT', '4242'), 10),
    livemode,
  };
}
