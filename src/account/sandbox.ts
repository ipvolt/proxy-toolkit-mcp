import { randomBytes } from 'node:crypto';
import type { AccountBackend, ApiFailure, ApiResult, RequestOptions } from './client.js';

/**
 * Sandbox mode: the account tools run against a simulated account that lives in
 * this process. Nothing here opens a socket, reads a key or touches a real
 * account. The answers follow the shapes and error codes of the ipvolt customer
 * API, so the tools above it run exactly the code they run against the API.
 */

export const SANDBOX_START_BALANCE_MINOR = 50_000;
export const SANDBOX_ROTATION_COOLDOWN_SECONDS = 30;
/** A name under the reserved .invalid domain never resolves (RFC 6761). */
export const SANDBOX_PROXY_HOST = 'proxy.sandbox.invalid';
/** Address blocks reserved for documentation (RFC 5737); they are never routed. */
const DOCUMENTATION_NETWORKS = ['203.0.113', '198.51.100', '192.0.2'] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const DAY_MS = 86_400_000;

/** Static startup failure. The messages are constants: no environment value is ever part of them. */
export class SandboxConfigurationError extends Error {
  readonly code = 'INVALID_SANDBOX_CONFIGURATION';
  constructor(reason: 'value' | 'key') {
    super(reason === 'key'
      ? 'IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_API_KEY. Unset one of them: the sandbox never uses a key, and a key always acts on the real account.'
      : 'IPVOLT_SANDBOX must be 0 or 1.');
    this.name = 'SandboxConfigurationError';
  }
}

/**
 * IPVOLT_SANDBOX: unset, empty or 0 is off; 1 is on. On together with an API key
 * is refused, so nobody can mistake a simulated rental for a real one or the reverse.
 */
export function readSandboxFlag(environment: NodeJS.ProcessEnv): boolean {
  const flag = environment.IPVOLT_SANDBOX;
  if (flag === undefined || flag === '' || flag === '0') return false;
  if (flag !== '1') throw new SandboxConfigurationError('value');
  if ((environment.IPVOLT_API_KEY ?? '').trim() !== '') throw new SandboxConfigurationError('key');
  return true;
}

interface SampleOffer { country: string; countryName: string; carrier: string; days: 1 | 30; priceMinor: number; available: boolean }

/**
 * Sample offers. The countries, carriers and prices are a subset of what the
 * public stock list showed on 18 November 2026; they are not updated and say
 * nothing about stock or prices now. One offer is marked sold out so that the
 * sold-out answers can be tried.
 */
const SAMPLE_OFFERS: readonly SampleOffer[] = [
  { country: 'US', countryName: 'United States', carrier: 'Verizon', days: 1, priceMinor: 1900, available: true },
  { country: 'US', countryName: 'United States', carrier: 'Verizon', days: 30, priceMinor: 13_900, available: true },
  { country: 'US', countryName: 'United States', carrier: 'T-Mobile', days: 1, priceMinor: 1900, available: true },
  { country: 'US', countryName: 'United States', carrier: 'T-Mobile', days: 30, priceMinor: 13_900, available: true },
  { country: 'US', countryName: 'United States', carrier: 'AT&T', days: 1, priceMinor: 1700, available: true },
  { country: 'US', countryName: 'United States', carrier: 'AT&T', days: 30, priceMinor: 12_900, available: true },
  { country: 'GB', countryName: 'United Kingdom', carrier: 'Three', days: 1, priceMinor: 1400, available: true },
  { country: 'GB', countryName: 'United Kingdom', carrier: 'Three', days: 30, priceMinor: 10_000, available: true },
  { country: 'DE', countryName: 'Germany', carrier: 'O2', days: 1, priceMinor: 900, available: true },
  { country: 'DE', countryName: 'Germany', carrier: 'O2', days: 30, priceMinor: 11_900, available: true },
  { country: 'FR', countryName: 'France', carrier: 'SFR', days: 1, priceMinor: 900, available: true },
  { country: 'FR', countryName: 'France', carrier: 'SFR', days: 30, priceMinor: 10_000, available: false },
];

interface SandboxRental {
  id: string; orderId: string; country: string; countryName: string; carrier: string;
  endsAt: number; externalIp: string; rotatedAt?: number; username: string; password: string;
}

export interface SandboxOptions { now?: () => number; balanceMinor?: number }

type Body = Record<string, unknown>;

function refuse(status: number, code: string, message: string, details: ApiFailure['details'] = {}): ApiResult {
  return { ok: false, error: { code, message, status, details } };
}
const accept = (data: Body): ApiResult => ({ ok: true, status: 200, data });
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const dollars = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export class SandboxApi implements AccountBackend {
  private readonly now: () => number;
  private balanceMinor: number;
  private spentDay = '';
  private spentMinor = 0;
  private addresses = 0;
  private readonly rentals = new Map<string, SandboxRental>();
  /** Accepted spending requests by Idempotency-Key, as the API keeps them with the order. */
  private readonly orders = new Map<string, { request: string; answer: Body }>();

  constructor(options: SandboxOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.balanceMinor = options.balanceMinor ?? SANDBOX_START_BALANCE_MINOR;
  }

  /** The sandbox holds no key, so no text can expose one. */
  exposes(_text: string): boolean { return false; }

  async get(path: string, options: RequestOptions = {}): Promise<ApiResult> { return this.handle('GET', path, options); }
  async post(path: string, options: RequestOptions = {}): Promise<ApiResult> { return this.handle('POST', path, { ...options, body: options.body ?? {} }); }

  private handle(method: 'GET' | 'POST', path: string, options: RequestOptions): ApiResult {
    // Nothing has happened yet, so a cancelled sandbox request has a known outcome: no change.
    if (options.signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } };
    let parts: string[], query: URLSearchParams;
    try {
      const url = new URL(path, 'http://sandbox.invalid');
      parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
      query = url.searchParams;
    } catch {
      return refuse(400, 'invalid_request', 'The request is not as documented.');
    }
    const [resource, id, action] = parts;
    const body = options.body ?? {};
    if (method === 'GET') {
      if (parts.length === 1 && resource === 'stock') return this.stock();
      if (parts.length === 1 && resource === 'key') return this.key();
      if (parts.length === 1 && resource === 'balance') return accept({ currency: 'USD', mode: 'sandbox', availableMinor: String(this.balanceMinor), heldMinor: '0' });
      if (parts.length === 1 && resource === 'rentals') return accept({ rentals: this.active().map(rental => this.describe(rental)) });
      if (parts.length === 2 && resource === 'rentals') return this.withRental(id!, rental => accept(this.describe(rental)));
      if (parts.length === 3 && resource === 'rentals' && action === 'extension-price') return this.withRental(id!, rental => this.extensionPrice(rental, query.get('days')));
    } else {
      if (parts.length === 1 && resource === 'rentals') return this.spend(method, path, options.idempotencyKey, body, () => this.rent(body));
      if (parts.length === 3 && resource === 'rentals' && action === 'rotate') return this.withRental(id!, rental => this.rotate(rental));
      if (parts.length === 3 && resource === 'rentals' && action === 'extend') return this.spend(method, path, options.idempotencyKey, body, () => this.withRental(id!, rental => this.extend(rental, body)));
    }
    return refuse(404, 'not_found', 'Nothing is at this address.');
  }

  /* ----------------------------------------------------------------- reads */

  private stock(): ApiResult {
    // No observedAt: these offers were not read from a supplier.
    return accept({
      currency: 'USD', purchasesOpen: true,
      offers: SAMPLE_OFFERS.map(offer => ({
        country: offer.country, countryName: offer.countryName, carrier: offer.carrier, days: offer.days,
        priceMinor: offer.available ? offer.priceMinor : null, available: offer.available,
      })),
    });
  }

  private key(): ApiResult {
    const today = this.today();
    return accept({
      id: 'sandbox', name: 'sandbox', access: 'read_write', dailyLimitMinor: null,
      spentTodayMinor: this.spentDay === today ? this.spentMinor : 0, remainingTodayMinor: null,
      dayResetsAt: new Date(Date.parse(`${today}T00:00:00.000Z`) + DAY_MS).toISOString(),
    });
  }

  private today(): string { return new Date(this.now()).toISOString().slice(0, 10); }
  private active(): SandboxRental[] { return [...this.rentals.values()].filter(rental => rental.endsAt > this.now()); }

  private withRental(id: string, then: (rental: SandboxRental) => ApiResult): ApiResult {
    const rental = this.rentals.get(id);
    if (!rental) return refuse(404, 'rental_not_found', 'No rental with this id on the sandbox account. list_rentals shows the active rentals.');
    if (rental.endsAt <= this.now()) return refuse(409, 'rental_ended', 'This rental has ended.');
    return then(rental);
  }

  private describe(rental: SandboxRental): Body {
    const endpoint = (port: number) => ({ host: SANDBOX_PROXY_HOST, port, username: rental.username, password: rental.password });
    return {
      id: rental.id, orderId: rental.orderId, status: 'active', country: rental.country, countryName: rental.countryName, carrier: rental.carrier,
      endsAt: new Date(rental.endsAt).toISOString(), online: true, externalIp: rental.externalIp, canRotate: true, canExtend: true,
      connection: { http: endpoint(10_000), socks5: endpoint(10_001) },
    };
  }

  private price(country: string, carrier: string, days: number): SampleOffer | undefined {
    return SAMPLE_OFFERS.find(offer => offer.country === country.toUpperCase() && offer.carrier.toLowerCase() === carrier.toLowerCase() && offer.days === days);
  }

  private extensionPrice(rental: SandboxRental, days: string | null): ApiResult {
    const length = days === '1' ? 1 : days === '30' ? 30 : undefined;
    const offer = length && this.price(rental.country, rental.carrier, length);
    if (!length || !offer) return refuse(400, 'invalid_request', 'The request is not as documented: days is 1 or 30.');
    return accept({ rentalId: rental.id, days: length, priceMinor: offer.priceMinor, currency: 'USD', endsAt: new Date(rental.endsAt).toISOString() });
  }

  /* -------------------------------------------------------------- spending */

  /** Idempotency as the API has it: the same key and request replays the order; the same key with another request is refused. */
  private spend(method: string, path: string, key: string | undefined, body: Body, place: () => ApiResult): ApiResult {
    if (key === undefined) return refuse(400, 'idempotency_key_required', 'Send an Idempotency-Key (8 to 128 letters, digits, - or _) so a repeated request is never charged twice.');
    if (!IDEMPOTENCY_KEY.test(key)) return refuse(400, 'invalid_idempotency_key', 'The Idempotency-Key must be 8 to 128 letters, digits, - or _.');
    const request = `${method} ${path} ${JSON.stringify(body)}`;
    const previous = this.orders.get(key);
    if (previous) {
      return previous.request === request
        ? accept({ ...previous.answer, replayed: true })
        : refuse(409, 'intent_conflict', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
    }
    const result = place();
    if (result.ok) this.orders.set(key, { request, answer: result.data });
    return result;
  }

  private charge(priceMinor: number, quantity: number, maxPriceMinor: number): ApiResult | number {
    if (priceMinor > maxPriceMinor) return refuse(409, 'price_above_max', 'The current price is above your maxPriceMinor. Nothing was charged.', { priceMinor, maxPriceMinor });
    const total = priceMinor * quantity;
    if (total > this.balanceMinor) {
      const missing = total - this.balanceMinor;
      return refuse(409, 'insufficient_balance', `The sandbox balance is ${dollars(missing)} short for this order. Nothing was charged.`,
        { requiredMinor: total, availableMinor: this.balanceMinor, missingMinor: missing });
    }
    this.balanceMinor -= total;
    const today = this.today();
    if (this.spentDay !== today) { this.spentDay = today; this.spentMinor = 0; }
    this.spentMinor += total;
    return total;
  }

  private rent(body: Body): ApiResult {
    const { country, carrier, days, maxPriceMinor } = body;
    const quantity = body.quantity ?? 1;
    if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country) || typeof carrier !== 'string' || !carrier || (days !== 1 && days !== 30) || !isInteger(quantity) || quantity < 1 || quantity > 20) {
      return refuse(400, 'invalid_order', 'The rental request is not as documented: send country, carrier, days (1 or 30), an optional quantity (1 to 20) and maxPriceMinor.');
    }
    if (!isInteger(maxPriceMinor) || maxPriceMinor < 0) return refuse(400, 'max_price_required', 'Send maxPriceMinor, the most you agree to pay per device in US cents. A higher current price is refused, never charged.');
    const offer = this.price(country, carrier, days);
    if (!offer || !offer.available) return refuse(409, 'stock_unavailable', 'Sold out for this country, carrier and rental length right now. Nothing was charged.');
    const charged = this.charge(offer.priceMinor, quantity, maxPriceMinor);
    if (typeof charged !== 'number') return charged;
    const orderId = `sandbox-order-${randomBytes(8).toString('hex')}`;
    for (let index = 0; index < quantity; index++) {
      const id = `sandbox-${randomBytes(8).toString('hex')}`;
      this.rentals.set(id, {
        id, orderId, country: offer.country, countryName: offer.countryName, carrier: offer.carrier,
        endsAt: this.now() + days * DAY_MS, externalIp: this.nextAddress(),
        // Made up for each rental at run time; they open nothing.
        username: `sandbox_${randomBytes(4).toString('hex')}`, password: `sandbox_${randomBytes(8).toString('hex')}`,
      });
    }
    // As the API answers: the order is paid at once and its rentals are read from the rental list.
    return accept({ orderId, status: 'paid', replayed: false, chargedMinor: charged, currency: 'USD', rentalIds: [] });
  }

  private extend(rental: SandboxRental, body: Body): ApiResult {
    const { days, maxPriceMinor } = body;
    if (days !== 1 && days !== 30) return refuse(400, 'invalid_renewal', 'The extension request is not as documented: send days (1 or 30) and maxPriceMinor.');
    if (!isInteger(maxPriceMinor) || maxPriceMinor < 0) return refuse(400, 'max_price_required', 'Send maxPriceMinor, the most you agree to pay per device in US cents. A higher current price is refused, never charged.');
    const offer = this.price(rental.country, rental.carrier, days);
    if (!offer) return refuse(409, 'proxy_not_renewable', 'This rental cannot be extended. Nothing was charged.');
    const charged = this.charge(offer.priceMinor, 1, maxPriceMinor);
    if (typeof charged !== 'number') return charged;
    rental.endsAt += days * DAY_MS;
    return accept({ orderId: `sandbox-order-${randomBytes(8).toString('hex')}`, status: 'paid', replayed: false, chargedMinor: charged, currency: 'USD', rentalId: rental.id, days });
  }

  private rotate(rental: SandboxRental): ApiResult {
    if (rental.rotatedAt !== undefined) {
      const waitMs = rental.rotatedAt + SANDBOX_ROTATION_COOLDOWN_SECONDS * 1000 - this.now();
      if (waitMs > 0) return refuse(429, 'rotation_cooldown', 'The IP was changed moments ago. Wait, then try again.', { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
    rental.rotatedAt = this.now();
    rental.externalIp = this.nextAddress();
    return accept({ rotated: true, pending: false, ip: rental.externalIp, message: 'The simulated IP address was changed.' });
  }

  /** Walks the documentation blocks in order, so two addresses in a row always differ. */
  private nextAddress(): string {
    const index = this.addresses++;
    return `${DOCUMENTATION_NETWORKS[index % DOCUMENTATION_NETWORKS.length]}.${1 + Math.floor(index / DOCUMENTATION_NETWORKS.length) % 254}`;
  }
}
