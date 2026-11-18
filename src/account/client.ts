import { assertSafeRouteEnvironment } from '../local/route-check.js';
import { VERSION } from '../meta.js';

/** The public customer API. Only IPVOLT_API_BASE (tests, local development) can change it. */
export const DEFAULT_API_BASE = 'https://ipvolt.com/beta/api/v1';
export const USER_AGENT = `ipvolt-proxy-toolkit-mcp/${VERSION}`;

// API keys are `ipvolt_` + 43 base64url characters; agent access tokens start `ipvolt_at_`.
const CREDENTIAL = /^ipvolt_[A-Za-z0-9_-]{16,200}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_RESPONSE_BYTES = 512 * 1024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** Numeric or date fields of API errors that help the user act. Everything else is dropped. */
const ERROR_NUMBERS = ['requiredMinor', 'availableMinor', 'missingMinor', 'priceMinor', 'maxPriceMinor', 'dailyLimitMinor', 'spentTodayMinor', 'remainingTodayMinor', 'remainingMinor', 'retryAfterSeconds'] as const;
type ErrorNumber = typeof ERROR_NUMBERS[number];

/** Sanitized startup failure: never contains the key, the base URL or a parser message. */
export class AccountConfigurationError extends Error {
  readonly code = 'INVALID_ACCOUNT_CONFIGURATION';
  constructor() {
    super('IPVOLT_API_KEY must be an ipvolt API key (ipvolt_...). IPVOLT_API_BASE, when set, must be an https URL (http only for 127.0.0.1 or localhost) without credentials, query or fragment.');
    this.name = 'AccountConfigurationError';
  }
}

export interface AccountConfig { apiKey: string; baseUrl: string }

/** Returns undefined when IPVOLT_API_KEY is unset or empty: the account tools are then not registered. */
export function readAccountConfig(environment: NodeJS.ProcessEnv): AccountConfig | undefined {
  const raw = environment.IPVOLT_API_KEY;
  if (raw === undefined || raw.trim() === '') return undefined;
  const apiKey = raw.trim();
  if (!CREDENTIAL.test(apiKey)) throw new AccountConfigurationError();
  // Node network debugging, TLS key logging or disabled verification could expose the key.
  assertSafeRouteEnvironment();
  return { apiKey, baseUrl: readBase(environment.IPVOLT_API_BASE) };
}

function readBase(value: string | undefined): string {
  if (value === undefined || value === '') return DEFAULT_API_BASE;
  try {
    if (value.length > 2048 || /[\u0000- \u007f?#]/u.test(value)) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new AccountConfigurationError();
  }
}

export interface ApiFailure {
  /** The API's stable `error` code, or one of ours: timeout, network_error, cancelled, unexpected_response, unexpected_redirect, http_error. */
  code: string;
  message: string;
  status?: number;
  /** A spending request may have reached the API; repeat it with the same requestId to learn the result. */
  outcomeUnknown?: boolean;
  details: Partial<Record<ErrorNumber, number>> & { resetsAt?: string };
}
export type ApiResult = { ok: true; status: number; data: Record<string, unknown> } | { ok: false; error: ApiFailure; network?: boolean };

export interface RequestOptions {
  /** Send the API key. Only the public stock list is read without it. */
  auth?: boolean;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal | undefined;
}
export interface AccountApiOptions { getTimeoutMs?: number; postTimeoutMs?: number; retryDelayMs?: number; fetch?: typeof fetch }

/** What the account tools need behind them: the API client below, or the in-process sandbox. */
export interface AccountBackend {
  get(path: string, options?: RequestOptions): Promise<ApiResult>;
  post(path: string, options?: RequestOptions): Promise<ApiResult>;
  /** True when text contains a credential this backend holds. */
  exposes(text: string): boolean;
}

function clean(text: string, limit = 300): string {
  const value = text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A small client for the ipvolt customer API. It never logs: requests, keys and
 * responses (which can contain proxy credentials) stay in memory and in the
 * tool result that asked for them.
 */
export class AccountApi implements AccountBackend {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly getTimeoutMs: number;
  private readonly postTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetcher: typeof fetch;

  constructor(config: AccountConfig, options: AccountApiOptions = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.getTimeoutMs = options.getTimeoutMs ?? 15_000;
    this.postTimeoutMs = options.postTimeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  /** True when text contains the configured key; used to refuse any output that would echo it. */
  exposes(text: string): boolean { return text.includes(this.apiKey); }

  /** GET may be retried once after a network error (never after a timeout or an HTTP answer). */
  async get(path: string, options: RequestOptions = {}): Promise<ApiResult> {
    const first = await this.once('GET', path, options);
    if (first.ok || !first.network || options.signal?.aborted) return first;
    await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
    if (options.signal?.aborted) return first;
    return this.once('GET', path, options);
  }

  /** POST is never retried here. Spending calls carry an Idempotency-Key so the caller can repeat them safely. */
  post(path: string, options: RequestOptions = {}): Promise<ApiResult> {
    return this.once('POST', path, { ...options, body: options.body ?? {} });
  }

  private async once(method: 'GET' | 'POST', path: string, options: RequestOptions): Promise<ApiResult> {
    const timeout = AbortSignal.timeout(method === 'GET' ? this.getTimeoutMs : this.postTimeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (options.auth !== false) headers.Authorization = `Bearer ${this.apiKey}`;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    const spending = method === 'POST';
    const interrupted = (): ApiResult => {
      if (options.signal?.aborted && !timeout.aborted) return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', ...(spending ? { outcomeUnknown: true } : {}), details: {} } };
      if (timeout.aborted) return { ok: false, error: { code: 'timeout', message: 'The ipvolt API did not answer in time.', ...(spending ? { outcomeUnknown: true } : {}), details: {} } };
      return { ok: false, network: true, error: { code: 'network_error', message: 'Could not reach the ipvolt API.', ...(spending ? { outcomeUnknown: true } : {}), details: {} } };
    };
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method, headers, signal, redirect: 'manual', cache: 'no-store',
        ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
      });
    } catch {
      return interrupted();
    }
    let text: string;
    try {
      text = await readBounded(response);
    } catch (error) {
      if (error instanceof TooLarge) return { ok: false, error: { code: 'unexpected_response', message: 'The ipvolt API answer was larger than expected.', status: response.status, details: {} } };
      const failure = interrupted();
      if (!failure.ok) failure.error.status = response.status;
      return failure;
    }
    const status = response.status;
    if (status >= 300 && status < 400) {
      return { ok: false, error: { code: 'unexpected_redirect', message: `The ipvolt API answered with a redirect (HTTP ${status}). It was not followed.`, status, details: {} } };
    }
    const json = /^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '') ? parse(text) : undefined;
    if (status >= 200 && status < 300) {
      if (!record(json)) return { ok: false, error: { code: 'unexpected_response', message: 'The ipvolt API answered in an unexpected format.', status, ...(spending ? { outcomeUnknown: true } : {}), details: {} } };
      return { ok: true, status, data: json };
    }
    return { ok: false, error: apiFailure(status, json, response.headers.get('retry-after'), spending) };
  }
}

class TooLarge extends Error {}
async function readBounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new TooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function apiFailure(status: number, body: unknown, retryAfter: string | null, spending: boolean): ApiFailure {
  const details: ApiFailure['details'] = {};
  if (record(body) && typeof body.error === 'string' && ERROR_CODE.test(body.error)) {
    for (const name of ERROR_NUMBERS) {
      const value = body[name];
      if (typeof value === 'number' && Number.isSafeInteger(value)) details[name] = value;
    }
    if (typeof body.resetsAt === 'string' && body.resetsAt.length <= 40) details.resetsAt = clean(body.resetsAt, 40);
    if (details.retryAfterSeconds === undefined && retryAfter && /^\d{1,6}$/.test(retryAfter)) details.retryAfterSeconds = Number(retryAfter);
    const message = typeof body.message === 'string' && body.message.trim() ? clean(body.message) : `The ipvolt API refused the request (${body.error}).`;
    // A JSON refusal below 500, or a 503, means this request charged nothing. Other 5xx answers are uncertain.
    const uncertain = spending && status >= 500 && status !== 503;
    return { code: body.error, message, status, ...(uncertain ? { outcomeUnknown: true } : {}), details };
  }
  if (retryAfter && /^\d{1,6}$/.test(retryAfter) && (status === 429 || status === 503)) details.retryAfterSeconds = Number(retryAfter);
  return {
    code: 'http_error', message: `The ipvolt API answered HTTP ${status} without an error description.`, status,
    ...(spending && status >= 500 ? { outcomeUnknown: true } : {}), details,
  };
}
