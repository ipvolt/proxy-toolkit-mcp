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
/** The most a request may name as its price ceiling, as the API has it. */
const MAX_PRICE_CEILING_MINOR = 1_000_000;

/** Static startup failure. The messages are constants: no environment value is ever part of them. */
export class SandboxConfigurationError extends Error {
  readonly code = 'INVALID_SANDBOX_CONFIGURATION';
  constructor(reason: 'value' | 'key' | 'route') {
    super(reason === 'key'
      ? 'IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_API_KEY. Unset one of them: the sandbox never uses a key, and a key always acts on the real account.'
      : reason === 'route'
        ? 'IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_ENABLE_ROUTE_CHECK=1. Unset one of them: the sandbox makes no network request, and the route check makes one through your proxy.'
        : 'IPVOLT_SANDBOX must be 0 or 1.');
    this.name = 'SandboxConfigurationError';
  }
}

/**
 * IPVOLT_SANDBOX: unset, empty or 0 is off; 1 is on. On together with an API key
 * is refused, so nobody can mistake a simulated rental for a real one or the reverse.
 * On together with the route check is refused too: that tool makes a real request
 * through a real proxy, and a server in sandbox mode makes none.
 */
export function readSandboxFlag(environment: NodeJS.ProcessEnv): boolean {
  const flag = environment.IPVOLT_SANDBOX;
  if (flag === undefined || flag === '' || flag === '0') return false;
  if (flag !== '1') throw new SandboxConfigurationError('value');
  if ((environment.IPVOLT_API_KEY ?? '').trim() !== '') throw new SandboxConfigurationError('key');
  if (environment.IPVOLT_ENABLE_ROUTE_CHECK === '1') throw new SandboxConfigurationError('route');
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
/** What an Idempotency-Key bought. A repeat that asks for the same thing gets this order back; anything else is a conflict. */
type PlacedOrder =
  | { operation: 'purchase'; country: string; carrier: string; days: 1 | 30; quantity: number; answer: Body; rentalIds: string[] }
  | { operation: 'renewal'; rentalId: string; days: 1 | 30; answer: Body };

function refuse(status: number, code: string, message: string, details: ApiFailure['details'] = {}): ApiResult {
  return { ok: false, error: { code, message, status, details } };
}
const accept = (data: Body): ApiResult => ({ ok: true, status: 200, data });
const integerIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const onlyKeys = (body: Body, allowed: readonly string[]) => Object.keys(body).every(key => allowed.includes(key));
const conflict = () => refuse(409, 'intent_conflict', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
const wrongMethod = () => refuse(405, 'method_not_allowed', 'This method is not allowed here.');
const dollars = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export class SandboxApi implements AccountBackend {
  private readonly now: () => number;
  private balanceMinor: number;
  private spentDay = '';
  private spentMinor = 0;
  private addresses = 0;
  private readonly rentals = new Map<string, SandboxRental>();
  /** Accepted spending requests by Idempotency-Key, as the API keeps them with the order. */
  private readonly orders = new Map<string, PlacedOrder>();

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
    const get = method === 'GET';
    if (parts.length === 1 && (resource === 'stock' || resource === 'key' || resource === 'balance')) {
      if (!get) return wrongMethod();
      return resource === 'stock' ? this.stock() : resource === 'key' ? this.key()
        : accept({ currency: 'USD', mode: 'sandbox', availableMinor: String(this.balanceMinor), heldMinor: '0' });
    }
    if (resource !== 'rentals' || parts.length > 3) return refuse(404, 'not_found', 'Nothing is at this address.');
    if (parts.length === 1) return get ? accept({ rentals: this.active().map(rental => this.describe(rental)) }) : this.rent(options.idempotencyKey, body);
    if (parts.length === 2) return get ? this.withRental(id!, rental => accept(this.describe(rental))) : wrongMethod();
    if (action === 'extension-price') return get ? this.extensionPrice(id!, query.get('days')) : wrongMethod();
    if (action === 'rotate') return get ? wrongMethod() : this.withRental(id!, rental => this.rotate(rental));
    if (action === 'extend') return get ? wrongMethod() : this.extend(id!, options.idempotencyKey, body);
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

  private extensionPrice(id: string, days: string | null): ApiResult {
    if (days !== '1' && days !== '30') return refuse(400, 'invalid_request', 'The request is not as documented: days is 1 or 30.');
    return this.withRental(id, rental => {
      const offer = this.price(rental.country, rental.carrier, Number(days));
      if (!offer) return refuse(409, 'proxy_not_renewable', 'This rental cannot be extended. Nothing was charged.');
      return accept({ rentalId: rental.id, days: Number(days), priceMinor: offer.priceMinor, currency: 'USD', endsAt: new Date(rental.endsAt).toISOString() });
    });
  }

  /* -------------------------------------------------------------- spending */

  private idempotency(key: string | undefined): ApiResult | undefined {
    if (key === undefined) return refuse(400, 'idempotency_key_required', 'Send an Idempotency-Key (8 to 128 letters, digits, - or _) so a repeated request is never charged twice.');
    if (!IDEMPOTENCY_KEY.test(key)) return refuse(400, 'invalid_idempotency_key', 'The Idempotency-Key must be 8 to 128 letters, digits, - or _.');
    return undefined;
  }

  private charge(priceMinor: number, quantity: number, maxPriceMinor: number): ApiResult | number {
    if (priceMinor > maxPriceMinor) return refuse(409, 'price_above_max', 'The current price is above your maxPriceMinor. Nothing was charged.', { priceMinor, maxPriceMinor });
    const total = priceMinor * quantity;
    if (total > this.balanceMinor) {
      const missing = total - this.balanceMinor;
      return refuse(409, 'insufficient_balance', `The sandbox balance is ${dollars(missing)} short for this request. Nothing was charged.`,
        { requiredMinor: total, availableMinor: this.balanceMinor, missingMinor: missing });
    }
    this.balanceMinor -= total;
    const today = this.today();
    if (this.spentDay !== today) { this.spentDay = today; this.spentMinor = 0; }
    this.spentMinor += total;
    return total;
  }

  /**
   * POST /rentals. As the API does, a used key is answered from its order before the body is checked: the same country,
   * carrier (any case), length and quantity replay it, whatever the price ceiling says; anything else is a conflict.
   */
  private rent(key: string | undefined, body: Body): ApiResult {
    const refused = this.idempotency(key);
    if (refused) return refused;
    const quantity = body.quantity === undefined ? 1 : body.quantity;
    const prior = this.orders.get(key!);
    if (prior) {
      const same = prior.operation === 'purchase' && prior.quantity === quantity && typeof body.country === 'string' && typeof body.carrier === 'string'
        && prior.country === body.country.toUpperCase() && prior.carrier.toLowerCase() === body.carrier.trim().toLowerCase() && prior.days === body.days;
      // By the time a request is repeated the simulated device exists, so the order reads as the API shows a finished one.
      return same ? accept({ ...prior.answer, status: 'fulfilled', replayed: true, rentalIds: prior.rentalIds }) : conflict();
    }
    const { country, carrier, days, maxPriceMinor } = body;
    if (!integerIn(quantity, 1, 20) || !onlyKeys(body, ['country', 'carrier', 'days', 'maxPriceMinor', 'quantity']) || typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country)
        || typeof carrier !== 'string' || !carrier.trim() || carrier.length > 60 || (days !== 1 && days !== 30)) {
      return refuse(400, 'invalid_order', 'The rental request is not as documented: send country, carrier, days (1 or 30), an optional quantity (1 to 20) and maxPriceMinor.');
    }
    if (maxPriceMinor === undefined) return refuse(400, 'max_price_required', 'Send maxPriceMinor, the most you agree to pay per device in US cents. A higher current price is refused, never charged.');
    if (!integerIn(maxPriceMinor, 1, MAX_PRICE_CEILING_MINOR)) return refuse(400, 'invalid_order', 'The rental request is not as documented: maxPriceMinor is a whole number of US cents from 1 to 1,000,000.');
    const offer = this.price(country, carrier.trim(), days);
    if (!offer || !offer.available) return refuse(409, 'stock_unavailable', 'Sold out for this country, carrier and rental length right now. Nothing was charged.');
    const charged = this.charge(offer.priceMinor, quantity, maxPriceMinor);
    if (typeof charged !== 'number') return charged;
    const orderId = `sandbox-order-${randomBytes(8).toString('hex')}`;
    const rentalIds: string[] = [];
    for (let index = 0; index < quantity; index++) {
      const id = `sandbox-${randomBytes(8).toString('hex')}`;
      rentalIds.push(id);
      this.rentals.set(id, {
        id, orderId, country: offer.country, countryName: offer.countryName, carrier: offer.carrier,
        endsAt: this.now() + days * DAY_MS, externalIp: this.nextAddress(),
        // Made up for each rental at run time; they open nothing.
        username: `sandbox_${randomBytes(4).toString('hex')}`, password: `sandbox_${randomBytes(8).toString('hex')}`,
      });
    }
    // As the API answers a new order: paid at once, its rentals not named yet. They are read from the rental list.
    const answer = { orderId, status: 'paid', replayed: false, chargedMinor: charged, currency: 'USD', rentalIds: [] };
    this.orders.set(key!, { operation: 'purchase', country: offer.country, carrier: offer.carrier, days, quantity, answer, rentalIds });
    return accept(answer);
  }

  /** POST /rentals/{id}/extend. The body is checked first, then a used key is answered from its order, then the rental is read. */
  private extend(id: string, key: string | undefined, body: Body): ApiResult {
    const refused = this.idempotency(key);
    if (refused) return refused;
    const { days, maxPriceMinor } = body;
    if (!onlyKeys(body, ['days', 'maxPriceMinor']) || (days !== 1 && days !== 30)) return refuse(400, 'invalid_renewal', 'The extension request is not as documented: send days (1 or 30) and maxPriceMinor.');
    if (maxPriceMinor === undefined) return refuse(400, 'max_price_required', 'Send maxPriceMinor, the most you agree to pay per device in US cents. A higher current price is refused, never charged.');
    if (!integerIn(maxPriceMinor, 1, MAX_PRICE_CEILING_MINOR)) return refuse(400, 'invalid_renewal', 'The extension request is not as documented: maxPriceMinor is a whole number of US cents from 1 to 1,000,000.');
    const prior = this.orders.get(key!);
    if (prior) {
      return prior.operation === 'renewal' && prior.rentalId === id && prior.days === days
        ? accept({ ...prior.answer, status: 'fulfilled', replayed: true }) : conflict();
    }
    return this.withRental(id, rental => {
      const offer = this.price(rental.country, rental.carrier, days);
      if (!offer) return refuse(409, 'proxy_not_renewable', 'This rental cannot be extended. Nothing was charged.');
      const charged = this.charge(offer.priceMinor, 1, maxPriceMinor);
      if (typeof charged !== 'number') return charged;
      rental.endsAt += days * DAY_MS;
      const answer = { orderId: `sandbox-order-${randomBytes(8).toString('hex')}`, status: 'paid', replayed: false, chargedMinor: charged, currency: 'USD', rentalId: rental.id, days };
      this.orders.set(key!, { operation: 'renewal', rentalId: rental.id, days, answer });
      return accept(answer);
    });
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
