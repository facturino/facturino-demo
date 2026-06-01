import Facturino from '@facturino/node'

/**
 * Runtime configuration, read once from the environment.
 *
 * Every value comes from `process.env` so the demo never hard-codes a key.
 * Copy `../.env.example` to `.env`, fill it in, and export it before running
 * (`set -a; . ./.env; set +a` or `node --env-file=.env`).
 */
export interface Config {
  /** Test-mode API key (`fac_test_…`). Required. */
  readonly apiKey: string
  /** API base URL, e.g. https://facturino.com/api/v1 (override for the emulator). */
  readonly baseUrl: string
  /** Signing secret returned by `webhookEndpoints.create` (`whsec_…`). */
  readonly webhookSecret: string
  /** Public HTTPS URL where Facturino can reach this server's /webhooks route. */
  readonly publicBaseUrl: string
  /** Local TCP port the HTTP server listens on. */
  readonly port: number
}

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy ../.env.example to .env and fill it in.`,
    )
  }
  return value
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value : fallback
}

/** Read and validate the environment. Throws early on a missing API key. */
export function loadConfig(): Config {
  const apiKey = required('FACTURINO_API_KEY')

  // Refuse anything other than a test-mode key: this demo is destructive by
  // nature (it creates companies, invoices, finalizes documents, …) and must
  // never run against live data.
  if (!apiKey.startsWith('fac_test_')) {
    throw new Error(
      'FACTURINO_API_KEY must be a test-mode key (fac_test_…). ' +
        'Refusing to run the demo against live data.',
    )
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(optional('FACTURINO_BASE_URL', 'https://facturino.com/api/v1')),
    // The webhook secret is only needed once an endpoint exists; keep it
    // optional so the catalogue/invoice steps run before webhooks are set up.
    webhookSecret: optional('FACTURINO_WEBHOOK_SECRET', ''),
    publicBaseUrl: optional('PUBLIC_BASE_URL', ''),
    port: Number.parseInt(optional('PORT', '4242'), 10),
  }
}

/**
 * The `@facturino/node` SDK already prefixes every request path with `/v1`
 * (and its own default base is `https://facturino.com/api`). The shared
 * `.env.example` ships the human-facing `https://facturino.com/api/v1` for
 * clarity, so we strip a trailing `/v1` here to avoid hitting
 * `.../api/v1/v1/invoices`. This mirrors the Python/PHP/Go demos.
 */
function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * Construct the Facturino SDK client.
 *
 * The SDK reads the key and base URL; everything else (auth header, retries
 * with exponential back-off, structured error mapping, cursor pagination) is
 * handled inside the SDK. See `@facturino/node`'s `HttpClient`.
 */
export function createClient(config: Config): Facturino {
  return new Facturino(config.apiKey, { baseUrl: config.baseUrl })
}
