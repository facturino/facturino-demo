/**
 * Facturino HTTP client — no SDK.
 *
 * This file is the whole point of the "no-SDK" demo: it hand-rolls everything
 * an official SDK would normally hide from you. Read it top to bottom to see
 * exactly what happens on the wire.
 *
 *   • Bearer authentication      → `Authorization: Bearer fac_test_…`
 *   • Idempotency keys           → `Idempotency-Key: <stable per logical op>`
 *   • Retry with backoff         → on 429 / 5xx, honouring `Retry-After`
 *   • Stripe-like error decoding  → `{ error: { type, code, message, … request_id } }`
 *   • Cursor pagination          → `starting_after` + `has_more` + `next_cursor`
 *
 * There is zero runtime dependency: `fetch` is the Node 20+ global, and the
 * only `node:` import is `node:crypto` for generating idempotency keys.
 */
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';

/** API version pinned by the demo. Sent on every request for forward-compat. */
const API_VERSION = '2026-03-01';

/** Default network timeout per attempt (ms). The API itself returns < 60s. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many times we retry a *retryable* failure before giving up. */
const MAX_RETRIES = 4;

/** Base delay for exponential backoff (ms): 0.5s, 1s, 2s, 4s (+ jitter). */
const BACKOFF_BASE_MS = 500;

/** HTTP verbs we support. Facturino uses PATCH (never PUT) for partial updates. */
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Stripe-like error body returned by the API on non-2xx responses. */
export interface ApiErrorBody {
  type?: string;
  code?: string;
  message?: string;
  param?: string;
  doc_url?: string;
  request_id?: string;
  hint?: string;
}

/**
 * Error thrown for any non-2xx response. Carries the decoded error envelope
 * plus the HTTP status, so callers can branch on `err.status === 404`, log
 * `err.requestId` for support, and read `err.hint`.
 */
export class FacturinoError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param: string | undefined;
  readonly docUrl: string | undefined;
  readonly requestId: string | undefined;
  readonly hint: string | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? `HTTP ${status}`);
    this.name = 'FacturinoError';
    this.status = status;
    this.type = body.type ?? 'api_error';
    this.code = body.code ?? 'unknown';
    this.param = body.param;
    this.docUrl = body.doc_url;
    this.requestId = body.request_id;
    this.hint = body.hint;
  }

  /** One-line summary suited to a server log — always surfaces request_id. */
  override toString(): string {
    const parts = [`[${this.status} ${this.type}/${this.code}] ${this.message}`];
    if (this.param) parts.push(`param=${this.param}`);
    if (this.hint) parts.push(`hint=${this.hint}`);
    if (this.requestId) parts.push(`request_id=${this.requestId}`);
    return parts.join(' · ');
  }
}

/** Options for a single {@link FacturinoClient.request} call. */
export interface RequestOptions {
  /** Query string parameters. Arrays are repeated; `undefined` is dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for POST/PATCH. Serialised with `JSON.stringify`. */
  body?: unknown;
  /**
   * Idempotency key. Set this on every *creation* POST so a retried request
   * (network blip, our own backoff) never creates a duplicate resource. The
   * server replays the original response for 24h. Keep it stable per logical
   * operation — see `idempotencyKey()` for a deterministic helper.
   */
  idempotencyKey?: string;
  /** Per-call override of the network timeout (ms). */
  timeoutMs?: number;
  /** Set `false` to disable retries (e.g. for non-idempotent edge cases). */
  retry?: boolean;
}

/**
 * Build a deterministic idempotency key from a logical operation name plus
 * any natural keys. Re-running the scenario reuses the same key, so creation
 * POSTs are safe to replay. (An SDK leaves this to you; we provide a helper.)
 */
export function idempotencyKey(operation: string, ...parts: string[]): string {
  const suffix = parts.length > 0 ? `:${parts.join(':')}` : '';
  return `demo:${operation}${suffix}`;
}

/** Generate a one-off (non-deterministic) idempotency key. */
export function randomIdempotencyKey(operation: string): string {
  return `demo:${operation}:${randomUUID()}`;
}

/** A page returned by a cursor-paginated list endpoint. */
export interface Page<T> {
  object: 'list';
  url?: string;
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decide whether a status code is worth retrying. */
function isRetryableStatus(status: number): boolean {
  // 429 = rate limited; 5xx = transient server error. 4xx (other) is a client
  // bug — retrying would just burn quota, so we surface it immediately.
  return status === 429 || (status >= 500 && status <= 599);
}

export class FacturinoClient {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Core request primitive. Everything else (resource helpers, pagination)
   * is built on this. Handles auth, idempotency, retry/backoff and error
   * decoding; returns the parsed JSON body typed as `T`.
   */
  async request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const retryEnabled = options.retry !== false;

    // Headers an SDK would set for you.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: 'application/json',
      'Facturino-Version': API_VERSION,
      'User-Agent': 'facturino-demo-no-sdk/1.0',
    };

    let serialisedBody: string | undefined;
    if (options.body !== undefined && method !== 'GET' && method !== 'DELETE') {
      headers['Content-Type'] = 'application/json';
      serialisedBody = JSON.stringify(options.body);
    }

    // The Idempotency-Key is what makes a retried POST safe. We send the SAME
    // key across all retry attempts of a single logical request, so the server
    // collapses duplicates into one created resource.
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let attempt = 0;
    // The loop below is the retry/backoff engine. It is the single most
    // important thing the SDK does for you under the hood.
    for (;;) {
      attempt++;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      );

      let response: Response;
      try {
        const init: RequestInit = { method, headers, signal: controller.signal };
        if (serialisedBody !== undefined) init.body = serialisedBody;
        response = await fetch(url, init);
      } catch (err) {
        // Network error / timeout / abort. Retry like a 5xx if allowed.
        clearTimeout(timeout);
        if (retryEnabled && attempt <= MAX_RETRIES) {
          await sleep(this.backoffDelay(attempt, null));
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new FacturinoError(0, {
          type: 'connection_error',
          code: 'network_error',
          message: `Network error calling ${method} ${path}: ${reason}`,
        });
      } finally {
        clearTimeout(timeout);
      }

      // Retry on 429 / 5xx, honouring Retry-After when the server sets it.
      if (isRetryableStatus(response.status) && retryEnabled && attempt <= MAX_RETRIES) {
        const retryAfter = this.parseRetryAfter(response.headers.get('Retry-After'));
        await sleep(this.backoffDelay(attempt, retryAfter));
        continue;
      }

      // 204 No Content (some DELETEs) — nothing to parse.
      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();
      const parsed = text ? safeJsonParse(text) : undefined;

      if (!response.ok) {
        const body: ApiErrorBody =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? (parsed as { error: ApiErrorBody }).error
            : { message: text || `HTTP ${response.status}` };
        // Fall back to the standard `X-Request-Id`/`Request-Id` header when the
        // body omitted request_id, so support always has a correlation id.
        if (!body.request_id) {
          const headerRequestId =
            response.headers.get('X-Request-Id') ?? response.headers.get('Request-Id');
          if (headerRequestId) body.request_id = headerRequestId;
        }
        throw new FacturinoError(response.status, body);
      }

      return parsed as T;
    }
  }

  // --- Verb sugar -----------------------------------------------------------

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, query ? { query } : {});
  }

  post<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const opts: RequestOptions = {};
    if (body !== undefined) opts.body = body;
    if (idempotencyKey) opts.idempotencyKey = idempotencyKey;
    return this.request<T>('POST', path, opts);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  // --- Pagination -----------------------------------------------------------

  /**
   * Fetch one page of a cursor-paginated list. Pass `next_cursor` from the
   * previous page as `startingAfter` to advance.
   */
  async list<T>(
    path: string,
    params: { limit?: number; startingAfter?: string; query?: RequestOptions['query'] } = {},
  ): Promise<Page<T>> {
    const query: Record<string, string | number | boolean | undefined> = { ...params.query };
    if (params.limit !== undefined) query['limit'] = params.limit;
    // Cursor-based pagination: `starting_after` is an item id, NOT an offset.
    if (params.startingAfter) query['starting_after'] = params.startingAfter;
    return this.request<Page<T>>('GET', path, { query });
  }

  /**
   * Walk every page of a cursor-paginated list and return all items. Follows
   * `has_more` / `next_cursor` exactly as an SDK's auto-paginator would.
   * Use with care on large collections.
   */
  async listAll<T extends { id: string }>(
    path: string,
    params: { limit?: number; query?: RequestOptions['query'] } = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await this.list<T>(path, {
        limit: params.limit ?? 100,
        ...(startingAfter ? { startingAfter } : {}),
        ...(params.query ? { query: params.query } : {}),
      });
      items.push(...page.data);
      if (!page.has_more) break;
      // Prefer the server-supplied cursor; fall back to the last item's id.
      const last = page.data[page.data.length - 1];
      startingAfter = page.next_cursor ?? last?.id;
      if (!startingAfter) break; // defensive: avoid an infinite loop
    }
    return items;
  }

  // --- Internals ------------------------------------------------------------

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.config.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Parse a `Retry-After` header (delta-seconds or HTTP date) into ms. */
  private parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  /**
   * Exponential backoff with full jitter. If the server told us how long to
   * wait (Retry-After), we respect that and add a little jitter on top.
   */
  private backoffDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) {
      return retryAfterMs + Math.floor(Math.random() * 250);
    }
    const exponential = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS);
    return exponential + jitter;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
