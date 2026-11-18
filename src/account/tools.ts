import { randomUUID } from 'node:crypto';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VERSION } from '../meta.js';
import { AccountApi, type AccountApiOptions, type AccountBackend, type AccountConfig, type ApiFailure, type ApiResult } from './client.js';
import { SANDBOX_START_BALANCE_MINOR, SandboxApi, type SandboxOptions } from './sandbox.js';

/* ------------------------------------------------------------------ inputs */

const days = z.union([z.literal(1), z.literal(30)]);
const rentalId = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/).describe('Rental id from list_rentals.');
const requestId = z.uuid().describe('The requestId returned by the preview. Use it only with confirm: true.');

export const stockInputSchema = z.strictObject({
  country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('Two-letter country code, for example US.'),
  carrier: z.string().min(1).max(64).optional().describe('Carrier name, for example Verizon.'),
  days: days.optional().describe('Rental length: 1 or 30 days.'),
  includeSoldOut: z.boolean().default(false).describe('Also list offers that are sold out now.'),
});
export const emptyInputSchema = z.strictObject({});
export const rentalInputSchema = z.strictObject({ rentalId });
export const rentInputSchema = z.strictObject({
  country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('Two-letter country code from list_stock. Required for the preview.'),
  carrier: z.string().min(1).max(64).optional().describe('Carrier name from list_stock. Required for the preview.'),
  days: days.optional().describe('Rental length, 1 or 30 days. Required for the preview.'),
  quantity: z.number().int().min(1).max(20).optional().describe('Number of devices, 1 to 20. Default 1.'),
  confirm: z.boolean().optional().describe('Leave out to preview the charge. Set true, with the preview requestId, only after the user approved that charge.'),
  requestId: requestId.optional(),
});
export const extendInputSchema = z.strictObject({
  rentalId,
  days: days.describe('Extend by 1 or 30 days.'),
  confirm: z.boolean().optional().describe('Leave out to preview the charge. Set true, with the preview requestId, only after the user approved that charge.'),
  requestId: requestId.optional(),
});

/* ----------------------------------------------------------------- outputs */

const errorOutput = z.strictObject({
  code: z.string(), message: z.string(), status: z.number().int().optional(),
  outcomeUnknown: z.boolean().optional(),
  requiredMinor: z.number().int().optional(), availableMinor: z.number().int().optional(), missingMinor: z.number().int().optional(),
  priceMinor: z.number().int().optional(), maxPriceMinor: z.number().int().optional(),
  dailyLimitMinor: z.number().int().optional(), spentTodayMinor: z.number().int().optional(), remainingTodayMinor: z.number().int().optional(),
  remainingMinor: z.number().int().optional(), retryAfterSeconds: z.number().int().optional(), resetsAt: z.string().optional(),
});
/** `sandbox: true` marks an answer from the simulated account of sandbox mode; it is absent on answers about a real account. */
const base = { ok: z.boolean(), summary: z.string(), error: errorOutput.optional(), sandbox: z.literal(true).optional() };
const offerOutput = z.strictObject({
  country: z.string(), countryName: z.string().optional(), carrier: z.string(), days: z.number().int(),
  priceMinor: z.number().int().nullable(), available: z.boolean(), includedGb: z.number().optional(),
});
const endpointOutput = z.strictObject({ host: z.string(), port: z.number().int(), username: z.string(), password: z.string() });
const rentalOutput = z.strictObject({
  id: z.string(), orderId: z.string().optional(), status: z.string(),
  country: z.string().optional(), countryName: z.string().optional(), carrier: z.string().optional(),
  endsAt: z.string().optional(), online: z.boolean().optional(), externalIp: z.string().nullable().optional(),
  canRotate: z.boolean().optional(), canExtend: z.boolean().optional(), includedGb: z.number().optional(),
  connection: z.strictObject({ http: endpointOutput.optional(), socks5: endpointOutput.optional() }).optional(),
});
const orderOutput = z.strictObject({
  orderId: z.string(), status: z.string(), replayed: z.boolean(), chargedMinor: z.number().int(), currency: z.string(),
  rentalIds: z.array(z.string()).optional(), rentalId: z.string().optional(), days: z.number().int().optional(),
});
export const stockOutputSchema = z.strictObject({
  ...base, currency: z.string().optional(), observedAt: z.string().optional(), purchasesOpen: z.boolean().optional(),
  offers: z.array(offerOutput).optional(), truncated: z.boolean().optional(),
});
export const balanceOutputSchema = z.strictObject({
  ...base,
  balance: z.strictObject({ currency: z.string(), availableMinor: z.number().int(), heldMinor: z.number().int() }).optional(),
  key: z.strictObject({
    name: z.string().optional(), access: z.string(), dailyLimitMinor: z.number().int().nullable(),
    spentTodayMinor: z.number().int().optional(), remainingTodayMinor: z.number().int().nullable(),
    dayResetsAt: z.string().optional(), expiresAt: z.string().optional(),
  }).optional(),
});
export const rentOutputSchema = z.strictObject({
  ...base, stage: z.enum(['preview', 'confirmed']).optional(), requestId: z.string().optional(),
  offer: offerOutput.optional(), quantity: z.number().int().optional(), priceMinor: z.number().int().optional(),
  totalMinor: z.number().int().optional(), currency: z.string().optional(), order: orderOutput.optional(),
});
export const rentalsOutputSchema = z.strictObject({ ...base, rentals: z.array(rentalOutput).optional(), truncated: z.boolean().optional() });
export const rentalOutputSchema = z.strictObject({ ...base, rental: rentalOutput.optional() });
export const rotateOutputSchema = z.strictObject({
  ...base, rentalId: z.string().optional(), rotated: z.boolean().optional(), pending: z.boolean().optional(),
  ip: z.string().nullable().optional(), message: z.string().optional(),
});
export const extendOutputSchema = z.strictObject({
  ...base, stage: z.enum(['preview', 'confirmed']).optional(), requestId: z.string().optional(), rentalId: z.string().optional(),
  days: z.number().int().optional(), priceMinor: z.number().int().optional(), currency: z.string().optional(),
  endsAt: z.string().optional(), order: orderOutput.optional(),
});

/* ------------------------------------------------------- API answer shapes */

const text = (limit: number) => z.string().max(limit);
const minor = z.number().int().nonnegative();
const apiOffer = z.object({
  country: text(8), countryName: text(120).optional(), carrier: text(120), days: z.number().int(),
  priceMinor: minor.nullable(), available: z.boolean(), includedGb: z.number().nonnegative().optional(),
});
// The API answers null, not an absent field, where it has no value: observedAt while the stock feed is unread, and a rental's
// order, country, carrier or end time when the device has none. The mappers below leave such fields out.
const apiStock = z.object({ currency: text(8).optional(), observedAt: text(40).nullish(), purchasesOpen: z.boolean().optional(), offers: z.array(apiOffer).max(10_000) });
const apiKey = z.object({
  name: text(128).optional(), access: text(32), dailyLimitMinor: minor.nullable().optional(), spentTodayMinor: minor.optional(),
  remainingTodayMinor: z.number().int().nullable().optional(), dayResetsAt: text(40).optional(), expiresAt: text(40).optional(),
});
const cents = z.union([z.string().regex(/^-?\d{1,15}$/).transform(Number), z.number().int()]);
const apiBalance = z.object({ currency: text(8).optional(), availableMinor: cents, heldMinor: cents.optional() });
const apiEndpoint = z.object({ host: text(255), port: z.number().int().min(1).max(65_535), username: text(512), password: text(512) });
const apiRental = z.object({
  id: text(128), orderId: text(128).nullish(), status: text(40),
  country: text(8).nullish(), countryName: text(120).nullish(), carrier: text(120).nullish(), endsAt: text(40).nullish(),
  online: z.boolean().optional(), externalIp: text(64).nullable().optional(), canRotate: z.boolean().optional(), canExtend: z.boolean().optional(),
  includedGb: z.number().nonnegative().optional(),
  connection: z.object({ http: apiEndpoint.optional(), socks5: apiEndpoint.optional() }).optional(),
});
const apiRentals = z.object({ rentals: z.array(apiRental).max(10_000) });
const apiOrder = z.object({
  orderId: text(128), status: text(40), replayed: z.boolean().optional(), chargedMinor: minor, currency: text(8).optional(),
  rentalIds: z.array(text(128)).max(100).optional(), rentalId: text(128).optional(), days: z.number().int().optional(),
});
const apiPrice = z.object({ days: z.number().int().optional(), priceMinor: minor, currency: text(8).optional(), endsAt: text(40).nullish() });
const apiRotation = z.object({ rotated: z.boolean().optional(), pending: z.boolean().optional(), ip: text(64).nullable().optional(), message: text(1000).optional() });

/* ---------------------------------------------------------------- helpers */

type Output = Record<string, unknown> & { ok: boolean; summary: string };
type Outcome = { output: Output; text: string };
type Offer = z.infer<typeof offerOutput>;
type Rental = z.infer<typeof rentalOutput>;
type Endpoint = z.infer<typeof endpointOutput>;

export function money(amountMinor: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
function oneLine(value: string, limit = 200): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat;
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const length = (value: number) => plural(value, 'day');
const ok = (output: Record<string, unknown> & { summary: string }, text?: string): Outcome => ({ output: { ok: true, ...output }, text: text ?? output.summary });

/** Hints say what the user can do next; the API's own message comes first. */
const HINTS: Record<string, string> = {
  invalid_api_key: 'Check IPVOLT_API_KEY: the key may be mistyped, expired or revoked. Create a new key in Account settings → API keys.',
  read_only_api_key: 'This API key is read-only. Create a read-write key in Account settings → API keys to rent, rotate or extend.',
  insufficient_scope: 'This credential lacks the permission for this action.',
  not_found: 'The ipvolt API does not offer this request. Account tools need the public API to be available; check IPVOLT_API_BASE if you set it.',
  rental_not_found: 'Check the rental id with list_rentals.',
  rental_ended: 'This rental has ended.',
  stock_unavailable: 'It is sold out right now. Check list_stock for what is in stock.',
  try_again_later: 'A rate limit was reached. Wait a few minutes before trying again.',
};

function describeFailure(error: ApiFailure, retry: string | undefined, sandbox: boolean): Outcome {
  const parts = [`${error.message.replace(/[.\s]+$/u, '')} (${error.code}).`];
  const d = error.details;
  if (error.code === 'insufficient_balance' && d.missingMinor !== undefined) parts.push(`Your balance is ${money(d.missingMinor)} short${d.requiredMinor !== undefined ? ` of the ${money(d.requiredMinor)} required` : ''}. ${sandbox ? 'The sandbox balance cannot be topped up; restart the server to reset it.' : 'Add funds in the dashboard, or pay your own USDC on Base through the top-up at https://ipvolt.com/api/v1 (see https://ipvolt.com/docs/api), then try again.'}`);
  if (error.code === 'price_above_max' && d.priceMinor !== undefined) parts.push(`The price is now ${money(d.priceMinor)}${d.maxPriceMinor !== undefined ? `, above the previewed ${money(d.maxPriceMinor)}` : ''}.`);
  if (error.code === 'daily_limit_exceeded' && d.remainingTodayMinor !== undefined) parts.push(`This key can spend ${money(d.remainingTodayMinor)} more today${d.resetsAt ? `; the limit resets at ${d.resetsAt}` : ''}.`);
  if (error.code === 'spend_cap_exceeded' && d.remainingMinor !== undefined) parts.push(`This credential can spend ${money(d.remainingMinor)} more.`);
  if (d.retryAfterSeconds !== undefined) parts.push(`Try again in ${plural(d.retryAfterSeconds, 'second')}.`);
  const hint = HINTS[error.code];
  if (hint) parts.push(hint);
  if (retry) parts.push(retry);
  const summary = parts.join(' ');
  const { details, ...rest } = error;
  return { output: { ok: false, summary, error: { ...rest, ...details } }, text: summary };
}

function offer(value: z.infer<typeof apiOffer>): Offer {
  return {
    country: value.country.toUpperCase(), ...(value.countryName ? { countryName: value.countryName } : {}), carrier: value.carrier,
    days: value.days, priceMinor: value.priceMinor, available: value.available,
    ...(value.includedGb !== undefined ? { includedGb: value.includedGb } : {}),
  };
}
function describeOffer(value: Offer): string {
  return `${value.country}${value.countryName ? ` ${value.countryName}` : ''}, ${value.carrier}, ${length(value.days)}`;
}
function allowance(includedGb: number | undefined): string {
  return includedGb === undefined ? '' : ` (includes ${includedGb} GB of data)`;
}
function rental(value: z.infer<typeof apiRental>): Rental {
  const endpoint = (e: z.infer<typeof apiEndpoint> | undefined): Endpoint | undefined => e && { host: e.host, port: e.port, username: e.username, password: e.password };
  const http = endpoint(value.connection?.http), socks5 = endpoint(value.connection?.socks5);
  return {
    id: value.id, ...(value.orderId ? { orderId: value.orderId } : {}), status: value.status,
    ...(value.country ? { country: value.country } : {}), ...(value.countryName ? { countryName: value.countryName } : {}),
    ...(value.carrier ? { carrier: value.carrier } : {}), ...(value.endsAt ? { endsAt: value.endsAt } : {}),
    ...(value.online !== undefined ? { online: value.online } : {}), ...(value.externalIp !== undefined ? { externalIp: value.externalIp } : {}),
    ...(value.canRotate !== undefined ? { canRotate: value.canRotate } : {}), ...(value.canExtend !== undefined ? { canExtend: value.canExtend } : {}),
    ...(value.includedGb !== undefined ? { includedGb: value.includedGb } : {}),
    ...(http || socks5 ? { connection: { ...(http ? { http } : {}), ...(socks5 ? { socks5 } : {}) } } : {}),
  };
}
function describeRental(value: Rental): string {
  const facts = [value.status];
  if (value.online !== undefined) facts.push(value.online ? 'online' : 'offline');
  if (value.endsAt) facts.push(`ends ${value.endsAt}`);
  if (value.externalIp) facts.push(`current IP ${value.externalIp}`);
  if (value.canRotate !== undefined) facts.push(value.canRotate ? 'can rotate' : 'cannot rotate');
  if (value.canExtend !== undefined) facts.push(value.canExtend ? 'can extend' : 'cannot extend');
  const place = [value.country, value.carrier].filter(Boolean).join(' ') + (value.countryName ? ` (${value.countryName})` : '');
  const lines = [`Rental ${value.id}${place ? `: ${place}` : ''}, ${facts.join(', ')}${allowance(value.includedGb)}.`];
  const show = (label: string, e: Endpoint) => lines.push(`  ${label}: host ${e.host}, port ${e.port}, username ${e.username}, password ${e.password}`);
  if (value.connection?.http) show('HTTP proxy', value.connection.http);
  if (value.connection?.socks5) show('SOCKS5 proxy', value.connection.socks5);
  return lines.join('\n');
}
const SECRET_NOTE = 'Connection details are secrets for this account: use them only in the user\'s own configuration and never paste them into public places.';

/* ---------------------------------------------------------------- sandbox */

/** First line of every account tool answer in sandbox mode. */
export const SANDBOX_NOTICE = 'SANDBOX: this is a simulated ipvolt account inside this process. The balance, charges and rentals below are pretend. Nothing real was rented or charged, and no request was sent to ipvolt.';
const SANDBOX_SUMMARY_PREFIX = 'Sandbox (simulated): ';
const SANDBOX_DESCRIPTION = 'SANDBOX MODE (IPVOLT_SANDBOX=1): this tool acts on a simulated account inside this process. It sends no request to ipvolt, charges nothing and rents no real proxy. Stock, prices, balance and connection details are sample data, and they reset when the server restarts. With an API key instead of the sandbox, the tool does this:';
const SANDBOX_CONNECTION_NOTE = 'These connection details are simulated: the host name cannot resolve and there is no proxy behind it.';
const SANDBOX_NOTES: Record<string, string> = {
  list_stock: 'These are sample offers and prices, not live stock. Current prices: https://ipvolt.com/pricing',
  get_balance: `The sandbox starts with a pretend balance of ${money(SANDBOX_START_BALANCE_MINOR)} and no rentals, and resets when the server restarts.`,
};
function markSandbox(tool: string, outcome: Outcome): Outcome {
  return {
    output: { ...outcome.output, summary: SANDBOX_SUMMARY_PREFIX + outcome.output.summary, sandbox: true },
    text: [SANDBOX_NOTICE, outcome.text, SANDBOX_NOTES[tool]].filter(Boolean).join('\n'),
  };
}
function order(value: z.infer<typeof apiOrder>, currency: string) {
  return {
    orderId: value.orderId, status: value.status, replayed: value.replayed ?? false, chargedMinor: value.chargedMinor,
    currency: value.currency ?? currency,
    ...(value.rentalIds ? { rentalIds: value.rentalIds } : {}), ...(value.rentalId ? { rentalId: value.rentalId } : {}),
    ...(value.days !== undefined ? { days: value.days } : {}),
  };
}

/* ------------------------------------------------------------ preview store */

type RentPreview = { kind: 'rent'; offer: Offer; quantity: number; priceMinor: number; currency: string; createdAt: number; sent: boolean };
type ExtendPreview = { kind: 'extend'; rentalId: string; days: 1 | 30; priceMinor: number; currency: string; createdAt: number; sent: boolean };
type Preview = RentPreview | ExtendPreview;
type Draft = Omit<RentPreview, 'createdAt' | 'sent'> | Omit<ExtendPreview, 'createdAt' | 'sent'>;

/**
 * Previews live only in this process. A preview that was never confirmed
 * expires; once a confirm was sent its requestId is kept, so repeating the
 * confirm sends the same Idempotency-Key and body and can never charge twice.
 */
export class PreviewStore {
  private readonly entries = new Map<string, Preview>();
  constructor(private readonly ttlMs = 15 * 60_000, private readonly limit = 256, private readonly now = () => Date.now()) {}
  add(preview: Draft): string {
    if (this.entries.size >= this.limit) {
      const victim = [...this.entries].find(([, entry]) => !entry.sent)?.[0] ?? this.entries.keys().next().value;
      if (victim !== undefined) this.entries.delete(victim);
    }
    const id = randomUUID();
    this.entries.set(id, { ...preview, createdAt: this.now(), sent: false } as Preview);
    return id;
  }
  get(id: string): Preview | 'expired' | undefined {
    const entry = this.entries.get(id);
    if (entry && !entry.sent && this.now() - entry.createdAt > this.ttlMs) { this.entries.delete(id); return 'expired'; }
    return entry;
  }
}

/* ------------------------------------------------------------------- tools */

export interface AccountTools { api: AccountBackend; previews: PreviewStore; sandbox?: boolean }
export function createAccountTools(config: AccountConfig, options: AccountApiOptions = {}): AccountTools {
  return { api: new AccountApi(config, options), previews: new PreviewStore() };
}
/** The same tools on the simulated account of sandbox mode: no key, no network. */
export function createSandboxTools(options: SandboxOptions = {}): AccountTools {
  return { api: new SandboxApi(options), previews: new PreviewStore(), sandbox: true };
}

const MAX_RESULT_BYTES = 256 * 1024;
const MAX_LISTED = 100;
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Spends the prepaid balance, which the tool cannot undo; a confirmed requestId makes repeats harmless. */
const spendAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
/** Replaces the device's IP address (open connections may drop); free; every call asks for a new IP. */
const rotateAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export type AccountToolMetric = { tool: string; status: 'ok' | 'error'; durationMs: number; version: string };

export const ACCOUNT_TOOL_NAMES = ['list_stock', 'get_balance', 'rent_proxy', 'list_rentals', 'get_rental', 'rotate_ip', 'extend_rental'] as const;

export function registerAccountTools(server: McpServer, tools: AccountTools, onToolComplete?: (metric: AccountToolMetric) => void): void {
  const { api, previews } = tools;
  const sandbox = tools.sandbox === true;
  const failure = (error: ApiFailure, retry?: string): Outcome => describeFailure(error, retry, sandbox);
  const localFailure = (code: string, message: string): Outcome => failure({ code, message, details: {} });
  const unexpected = (status?: number): Outcome => failure({ code: 'unexpected_response', message: 'The ipvolt API answered in an unexpected format', ...(status ? { status } : {}), details: {} });
  /** In sandbox mode the title, description and hints say what is true there: nothing leaves the process and nothing is spent. */
  const describe = <A extends { destructiveHint: boolean; openWorldHint: boolean }>(title: string, description: string, annotations: A) => sandbox
    ? { title: `${title} (sandbox)`, description: `${SANDBOX_DESCRIPTION} ${description}`, annotations: { ...annotations, destructiveHint: false, openWorldHint: false } }
    : { title, description, annotations };
  const connectionNote = sandbox ? SANDBOX_CONNECTION_NOTE : SECRET_NOTE;

  async function run(tool: string, operation: () => Promise<Outcome>): Promise<CallToolResult> {
    const start = performance.now();
    let status: 'ok' | 'error' = 'error';
    try {
      const marked = (outcome: Outcome) => sandbox ? markSandbox(tool, outcome) : outcome;
      let outcome: Outcome;
      try { outcome = marked(await operation()); } catch { outcome = marked(localFailure('internal_error', 'The tool could not complete this request')); }
      let encoded = JSON.stringify(outcome.output);
      // Defence in depth: no result may carry the API key, whatever the API answered.
      if (api.exposes(encoded) || api.exposes(outcome.text)) {
        outcome = marked(localFailure('unsafe_response', 'The answer was withheld because it contained the API key'));
        encoded = JSON.stringify(outcome.output);
      }
      if (Buffer.byteLength(encoded) + Buffer.byteLength(outcome.text) > MAX_RESULT_BYTES) {
        outcome = marked(localFailure('response_too_large', 'The answer is larger than this tool returns'));
      }
      status = outcome.output.ok ? 'ok' : 'error';
      return {
        content: [{ type: 'text', text: outcome.text }],
        structuredContent: outcome.output,
        ...(outcome.output.ok ? {} : { isError: true }),
      };
    } finally {
      // Metrics never contain arguments, results, keys or connection details.
      try { onToolComplete?.({ tool, status, durationMs: Math.round(performance.now() - start), version: VERSION }); } catch { /* ignore */ }
    }
  }
  const signalOf = (context: { mcpReq: { signal: AbortSignal } }) => context.mcpReq.signal;
  const parsed = <T>(result: ApiResult, schema: z.ZodType<T>): { value: T } | { outcome: Outcome } => {
    if (!result.ok) return { outcome: failure(result.error) };
    const value = schema.safeParse(result.data);
    return value.success ? { value: value.data } : { outcome: unexpected(result.status) };
  };

  server.registerTool('list_stock', {
    ...describe('List mobile proxy stock and prices',
      'Read-only, free. List the mobile proxy rentals ipvolt sells now: country, carrier, length (1 or 30 days), price in US dollars and whether each is in stock. It never shows stock counts. Filter by country, carrier or length. Use it before rent_proxy.',
      readAnnotations),
    inputSchema: stockInputSchema, outputSchema: stockOutputSchema,
  }, (input, context) => run('list_stock', async () => {
    const result = parsed(await api.get('/stock', { auth: false, signal: signalOf(context) }), apiStock);
    if ('outcome' in result) return result.outcome;
    const stock = result.value;
    const currency = stock.currency ?? 'USD';
    const country = input.country?.toUpperCase(), carrier = input.carrier?.toLowerCase();
    const all = stock.offers.map(offer).filter(o => (!country || o.country === country) && (!carrier || o.carrier.toLowerCase() === carrier) && (!input.days || o.days === input.days));
    const matching = input.includeSoldOut ? all : all.filter(o => o.available && o.priceMinor !== null);
    const offers = matching.slice(0, 1000);
    const lines = offers.slice(0, 300).map(o => `- ${describeOffer(o)}: ${o.available && o.priceMinor !== null ? money(o.priceMinor, currency) : 'sold out'}${allowance(o.includedGb)}`);
    const filters = [country, input.carrier, input.days ? length(input.days) : undefined].filter(Boolean).join(', ');
    const open = stock.purchasesOpen === false ? 'Purchases are closed right now.' : 'Rent with rent_proxy, which shows the exact charge before renting.';
    const summary = offers.length
      ? `${plural(offers.length, 'offer')}${filters ? ` for ${filters}` : ''}${input.includeSoldOut ? '' : ' in stock'}. ${open}`
      : `No ${input.includeSoldOut ? '' : 'in-stock '}offers${filters ? ` for ${filters}` : ''} right now.${stock.purchasesOpen === false ? ' Purchases are closed right now.' : ''}`;
    const header = stock.observedAt ? `Prices observed ${stock.observedAt}.` : '';
    return ok({
      summary, currency, ...(stock.observedAt ? { observedAt: stock.observedAt } : {}),
      ...(stock.purchasesOpen !== undefined ? { purchasesOpen: stock.purchasesOpen } : {}),
      offers, ...(matching.length > offers.length ? { truncated: true } : {}),
    }, [summary, header, ...lines, offers.length > lines.length ? `(${offers.length - lines.length} more in the structured result)` : ''].filter(Boolean).join('\n'));
  }));

  server.registerTool('get_balance', {
    ...describe('Show balance and API key limits',
      'Read-only, free. Show the prepaid ipvolt balance (available and held) and this API key\'s access level (read only or read and write), daily spending limit, what it spent today and what it can still spend today.',
      readAnnotations),
    inputSchema: emptyInputSchema, outputSchema: balanceOutputSchema,
  }, (_input, context) => run('get_balance', async () => {
    const signal = signalOf(context);
    const [balanceResult, keyResult] = await Promise.all([api.get('/balance', { signal }), api.get('/key', { signal })]);
    const balance = parsed(balanceResult, apiBalance);
    if ('outcome' in balance) return balance.outcome;
    const currency = balance.value.currency ?? 'USD';
    const values = { currency, availableMinor: balance.value.availableMinor, heldMinor: balance.value.heldMinor ?? 0 };
    const lines = [`Available balance: ${money(values.availableMinor, currency)}${values.heldMinor ? ` (${money(values.heldMinor, currency)} held for orders in progress)` : ''}.`];
    const key = parsed(keyResult, apiKey);
    let keyOutput: Record<string, unknown> | undefined;
    if ('value' in key) {
      const k = key.value;
      const limit = k.dailyLimitMinor ?? null, remaining = k.remainingTodayMinor ?? null;
      keyOutput = {
        ...(k.name ? { name: oneLine(k.name, 64) } : {}), access: k.access, dailyLimitMinor: limit,
        ...(k.spentTodayMinor !== undefined ? { spentTodayMinor: k.spentTodayMinor } : {}), remainingTodayMinor: remaining,
        ...(k.dayResetsAt ? { dayResetsAt: k.dayResetsAt } : {}), ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
      };
      const access = k.access === 'read_write' ? 'read and write (can rent, rotate and extend)' : k.access === 'read' ? 'read only' : oneLine(k.access, 32);
      lines.push(`API key${k.name ? ` "${oneLine(k.name, 64)}"` : ''}: ${access}${k.expiresAt ? `, expires ${k.expiresAt}` : ''}.`);
      lines.push(limit === null
        ? `No daily limit: the balance is the limit${k.spentTodayMinor !== undefined ? ` (spent today: ${money(k.spentTodayMinor, currency)})` : ''}.`
        : `Daily limit ${money(limit, currency)}${k.spentTodayMinor !== undefined ? `, spent today ${money(k.spentTodayMinor, currency)}` : ''}${remaining !== null ? `, remaining today ${money(remaining, currency)}` : ''}${k.dayResetsAt ? ` (resets ${k.dayResetsAt})` : ''}.`);
    } else {
      const code = (key.outcome.output.error as { code?: string } | undefined)?.code ?? 'unexpected_response';
      lines.push(`API key details are unavailable (${code}).`);
    }
    return ok({ summary: lines.join(' '), balance: values, ...(keyOutput ? { key: keyOutput } : {}) });
  }));

  server.registerTool('rent_proxy', {
    ...describe('Rent a mobile proxy (spends balance)',
      'SPENDS MONEY from the prepaid ipvolt balance. Rent mobile proxy devices for 1 or 30 days. Two steps: (1) call with country, carrier and days (and optional quantity) and without confirm: this only looks up the current price and returns the exact charge and a requestId; nothing is charged. (2) Only after the user approves that charge, call again with confirm: true and that requestId. The confirmed request carries the requestId as its idempotency key and the previewed price as the maximum, so repeating it never charges twice and a price rise is refused, not charged. Needs a read-write API key; the key\'s daily limit applies. The Acceptable Use Policy (https://ipvolt.com/acceptable-use) applies.',
      spendAnnotations),
    inputSchema: rentInputSchema, outputSchema: rentOutputSchema,
  }, (input, context) => run('rent_proxy', async () => {
    const signal = signalOf(context);
    if (input.confirm !== true) {
      if (input.requestId) return localFailure('confirm_required', 'A requestId is only used with confirm: true. To rent, call again with confirm: true and this requestId; to see a fresh price, leave requestId out');
      if (!input.country || !input.carrier || !input.days) return localFailure('invalid_request', 'Give country, carrier and days (1 or 30) to see the price. list_stock shows what is available');
      const quantity = input.quantity ?? 1;
      const result = parsed(await api.get('/stock', { auth: false, signal }), apiStock);
      if ('outcome' in result) return result.outcome;
      const currency = result.value.currency ?? 'USD';
      const country = input.country.toUpperCase(), carrier = input.carrier.toLowerCase();
      const candidates = result.value.offers.map(offer).filter(o => o.country === country && o.carrier.toLowerCase() === carrier && o.days === input.days);
      const label = `${country} ${input.carrier} for ${length(input.days)}`;
      if (!candidates.length) return localFailure('offer_not_found', `ipvolt does not sell ${label}. list_stock shows the countries, carriers and lengths on sale`);
      if (result.value.purchasesOpen === false) return localFailure('purchases_closed', 'Purchases are closed right now. Nothing was charged');
      const best = candidates.filter(o => o.available && o.priceMinor !== null).sort((a, b) => a.priceMinor! - b.priceMinor!)[0];
      if (!best) return localFailure('stock_unavailable', `${label} is sold out right now. Nothing was charged. list_stock shows what is in stock`);
      const priceMinor = best.priceMinor!;
      const totalMinor = priceMinor * quantity;
      const id = previews.add({ kind: 'rent', offer: best, quantity, priceMinor, currency });
      const summary = `Renting ${quantity} × ${best.country} ${best.carrier} for ${length(best.days)} will charge ${money(totalMinor, currency)}${quantity > 1 ? ` (${money(priceMinor, currency)} each)` : ''} from your balance${quantity > 1 && best.includedGb !== undefined ? ` (each includes ${best.includedGb} GB of data)` : allowance(best.includedGb)}. Nothing has been charged yet. To proceed, call rent_proxy again with confirm: true and requestId: ${id}`;
      return ok({ summary, stage: 'preview', requestId: id, offer: best, quantity, priceMinor, totalMinor, currency },
        `${summary}\nAsk the user to approve this charge first. If the price rises before you confirm, the API refuses the rental instead of charging more. The preview expires in 15 minutes.`);
    }
    if (!input.requestId) return localFailure('request_id_required', 'confirm: true needs the requestId from a rent_proxy preview. Call rent_proxy without confirm first');
    const preview = previews.get(input.requestId);
    if (preview === 'expired') return localFailure('preview_expired', 'This preview expired before it was confirmed. Nothing was charged. Call rent_proxy without confirm for a current price');
    if (!preview || preview.kind !== 'rent') return localFailure('unknown_request', 'This requestId is not from a rent_proxy preview in this session. Nothing was sent. If an earlier confirm may have gone through, check list_rentals; otherwise call rent_proxy without confirm for a new preview');
    if ((input.country && input.country.toUpperCase() !== preview.offer.country) || (input.carrier && input.carrier.toLowerCase() !== preview.offer.carrier.toLowerCase()) ||
        (input.days && input.days !== preview.offer.days) || (input.quantity && input.quantity !== preview.quantity)) {
      return localFailure('preview_mismatch', 'These details differ from the preview with this requestId. Nothing was sent. Confirm with only confirm: true and the requestId, or preview the new choice');
    }
    preview.sent = true;
    const response = await api.post('/rentals', {
      signal, idempotencyKey: input.requestId,
      body: { country: preview.offer.country, carrier: preview.offer.carrier, days: preview.offer.days, quantity: preview.quantity, maxPriceMinor: preview.priceMinor },
    });
    const again = `call rent_proxy again with confirm: true and requestId: ${input.requestId}`;
    if (!response.ok) {
      return failure(response.error, response.error.outcomeUnknown
        ? `The outcome is unknown: the rental may have been placed. To find out, ${again}. The API returns the existing order and never charges twice.`
        : 'This request charged nothing. Call rent_proxy without confirm for a new preview before trying again.');
    }
    const result = apiOrder.safeParse(response.data);
    if (!result.success) return failure({ code: 'unexpected_response', message: 'The ipvolt API accepted the request but its answer had an unexpected format', status: response.status, outcomeUnknown: true, details: {} }, `To see the order, ${again}; it never charges twice.`);
    const placed = order(result.data, preview.currency);
    const summary = placed.replayed
      ? `This requestId was already confirmed: order ${placed.orderId} (status ${placed.status}, ${money(placed.chargedMinor, placed.currency)} charged) was returned and nothing was charged again.`
      : `Order ${placed.orderId} accepted (status ${placed.status}): ${money(placed.chargedMinor, placed.currency)} charged from your balance for ${preview.quantity} × ${preview.offer.country} ${preview.offer.carrier} for ${length(preview.offer.days)}.`;
    return ok({ summary, stage: 'confirmed', requestId: input.requestId, offer: preview.offer, quantity: preview.quantity, priceMinor: preview.priceMinor, totalMinor: preview.priceMinor * preview.quantity, currency: placed.currency, order: placed },
      `${summary}\nThe device is usually ready within minutes: call list_rentals to see it and its connection details. If setup fails, the order ends payment_failed and the money returns to the balance.`);
  }));

  server.registerTool('list_rentals', {
    ...describe('List your active rentals',
      'Read-only, free. List this account\'s active proxy rentals with their connection details (host, ports, username, password), end time, online state, current IP and whether each can rotate or extend. The connection details are secrets: keep them in the user\'s own configuration.',
      readAnnotations),
    inputSchema: emptyInputSchema, outputSchema: rentalsOutputSchema,
  }, (_input, context) => run('list_rentals', async () => {
    const result = parsed(await api.get('/rentals', { signal: signalOf(context) }), apiRentals);
    if ('outcome' in result) return result.outcome;
    const rentals = result.value.rentals.slice(0, MAX_LISTED).map(rental);
    const truncated = result.value.rentals.length > rentals.length;
    const summary = rentals.length
      ? `${plural(result.value.rentals.length, 'active rental')}${truncated ? `; the first ${rentals.length} are shown` : ''}.`
      : 'No active rentals. list_stock shows what can be rented.';
    return ok({ summary, rentals, ...(truncated ? { truncated: true } : {}) },
      [summary, ...rentals.map(describeRental), rentals.length ? connectionNote : ''].filter(Boolean).join('\n'));
  }));

  server.registerTool('get_rental', {
    ...describe('Show one rental',
      'Read-only, free. Show one of this account\'s active rentals with its connection details (host, ports, username, password), end time, online state, current IP and whether it can rotate or extend. The connection details are secrets: keep them in the user\'s own configuration.',
      readAnnotations),
    inputSchema: rentalInputSchema, outputSchema: rentalOutputSchema,
  }, (input, context) => run('get_rental', async () => {
    const result = parsed(await api.get(`/rentals/${encodeURIComponent(input.rentalId)}`, { signal: signalOf(context) }), apiRental);
    if ('outcome' in result) return result.outcome;
    const value = rental(result.value);
    const described = describeRental(value);
    return ok({ summary: described.split('\n')[0]!, rental: value }, `${described}\n${connectionNote}`);
  }));

  server.registerTool('rotate_ip', {
    ...describe('Rotate a rental\'s IP address',
      'CHANGES STATE, costs nothing. Ask for a new IP address on one of this account\'s rentals. Connections open through the device may drop while it changes. Rotating too soon is refused with the number of seconds to wait; the dashboard\'s limits apply. Needs a read-write API key. The Acceptable Use Policy (https://ipvolt.com/acceptable-use) applies.',
      rotateAnnotations),
    inputSchema: rentalInputSchema, outputSchema: rotateOutputSchema,
  }, (input, context) => run('rotate_ip', async () => {
    const response = await api.post(`/rentals/${encodeURIComponent(input.rentalId)}/rotate`, { signal: signalOf(context) });
    const result = parsed(response, apiRotation);
    if ('outcome' in result) return result.outcome;
    const r = result.value;
    const message = r.message ? oneLine(r.message, 300) : undefined;
    const summary = r.pending
      ? `Rotation of rental ${input.rentalId} is running; the new IP is usually ready within a minute. Check it with get_rental. Rotation is free.`
      : r.rotated === false
        ? `Rental ${input.rentalId} was not rotated${message ? `: ${message}` : '.'}`
        : `Rental ${input.rentalId} rotated${r.ip ? `; its new IP is ${r.ip}` : ''}. Rotation is free.`;
    return ok({
      summary, rentalId: input.rentalId, ...(r.rotated !== undefined ? { rotated: r.rotated } : {}), ...(r.pending !== undefined ? { pending: r.pending } : {}),
      ...(r.ip !== undefined ? { ip: r.ip } : {}), ...(message ? { message } : {}),
    });
  }));

  server.registerTool('extend_rental', {
    ...describe('Extend a rental (spends balance)',
      'SPENDS MONEY from the prepaid ipvolt balance. Extend one of this account\'s active rentals by 1 or 30 days. Two steps: (1) call with rentalId and days and without confirm: this only looks up the current extension price and returns the exact charge and a requestId; nothing is charged. (2) Only after the user approves that charge, call again with confirm: true and that requestId. The confirmed request carries the requestId as its idempotency key and the previewed price as the maximum, so repeating it never charges twice and a price rise is refused, not charged. Needs a read-write API key; the key\'s daily limit applies.',
      spendAnnotations),
    inputSchema: extendInputSchema, outputSchema: extendOutputSchema,
  }, (input, context) => run('extend_rental', async () => {
    const signal = signalOf(context);
    const path = `/rentals/${encodeURIComponent(input.rentalId)}`;
    if (input.confirm !== true) {
      if (input.requestId) return localFailure('confirm_required', 'A requestId is only used with confirm: true. To extend, call again with confirm: true and this requestId; to see a fresh price, leave requestId out');
      const result = parsed(await api.get(`${path}/extension-price?days=${input.days}`, { signal }), apiPrice);
      if ('outcome' in result) return result.outcome;
      const currency = result.value.currency ?? 'USD', priceMinor = result.value.priceMinor;
      const id = previews.add({ kind: 'extend', rentalId: input.rentalId, days: input.days, priceMinor, currency });
      const summary = `Extending rental ${input.rentalId} by ${length(input.days)} will charge ${money(priceMinor, currency)} from your balance. Nothing has been charged yet. To proceed, call extend_rental again with confirm: true and requestId: ${id}`;
      return ok({ summary, stage: 'preview', requestId: id, rentalId: input.rentalId, days: input.days, priceMinor, currency, ...(result.value.endsAt ? { endsAt: result.value.endsAt } : {}) },
        `${summary}\n${result.value.endsAt ? `End time reported with the price: ${result.value.endsAt}. ` : ''}Ask the user to approve this charge first. If the price rises before you confirm, the API refuses the extension instead of charging more. The preview expires in 15 minutes.`);
    }
    if (!input.requestId) return localFailure('request_id_required', 'confirm: true needs the requestId from an extend_rental preview. Call extend_rental without confirm first');
    const preview = previews.get(input.requestId);
    if (preview === 'expired') return localFailure('preview_expired', 'This preview expired before it was confirmed. Nothing was charged. Call extend_rental without confirm for a current price');
    if (!preview || preview.kind !== 'extend') return localFailure('unknown_request', 'This requestId is not from an extend_rental preview in this session. Nothing was sent. If an earlier confirm may have gone through, check get_rental; otherwise call extend_rental without confirm for a new preview');
    if (input.rentalId !== preview.rentalId || input.days !== preview.days) return localFailure('preview_mismatch', 'The rental or length differs from the preview with this requestId. Nothing was sent. Preview the new choice first');
    preview.sent = true;
    const response = await api.post(`${path}/extend`, { signal, idempotencyKey: input.requestId, body: { days: preview.days, maxPriceMinor: preview.priceMinor } });
    const again = `call extend_rental again with the same rentalId, days, confirm: true and requestId: ${input.requestId}`;
    if (!response.ok) {
      return failure(response.error, response.error.outcomeUnknown
        ? `The outcome is unknown: the extension may have been placed. To find out, ${again}. The API returns the existing order and never charges twice.`
        : 'This request charged nothing. Call extend_rental without confirm for a new preview before trying again.');
    }
    const result = apiOrder.safeParse(response.data);
    if (!result.success) return failure({ code: 'unexpected_response', message: 'The ipvolt API accepted the request but its answer had an unexpected format', status: response.status, outcomeUnknown: true, details: {} }, `To see the order, ${again}; it never charges twice.`);
    const placed = order(result.data, preview.currency);
    const summary = placed.replayed
      ? `This requestId was already confirmed: order ${placed.orderId} (status ${placed.status}, ${money(placed.chargedMinor, placed.currency)} charged) was returned and nothing was charged again.`
      : `Extension order ${placed.orderId} accepted (status ${placed.status}): ${money(placed.chargedMinor, placed.currency)} charged from your balance to extend rental ${preview.rentalId} by ${length(preview.days)}.`;
    return ok({ summary, stage: 'confirmed', requestId: input.requestId, rentalId: preview.rentalId, days: preview.days, priceMinor: preview.priceMinor, currency: placed.currency, order: placed },
      `${summary}\nCheck the new end time with get_rental.`);
  }));
}
