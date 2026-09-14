import { z } from "zod";
import { clientSchema, clientVersionSchema, isSupportedClientVersion } from "./config.js";

export const diagnosticsInputSchema = z.strictObject({
  client: clientSchema,
  version: clientVersionSchema,
  phase: z.enum(["configuration", "pool", "proxy_connect", "connect_tunnel", "target_tls", "request_send", "response_headers", "response_body", "unknown"]),
  status: z.number().int().min(100).max(599).optional().describe("Observed HTTP status; identify its responding layer separately."),
  exception: z.enum(["proxy_error", "tls_error", "connect_timeout", "read_timeout", "write_timeout", "pool_timeout", "connection_refused", "dns_error", "connection_reset", "protocol_error", "timeout", "invalid_configuration", "unknown"]).optional().describe("Normalized category, not raw exception text. HTTPX ConnectError alone does not establish a TLS error."),
  responseSource: z.enum(["proxy", "target", "unknown"]).default("unknown").describe("Use target/proxy only when established by response provenance, not merely the status code."),
  method: z.enum(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "POST", "PATCH", "unknown"]).default("unknown"),
  requestMayHaveBeenSent: z.boolean().optional().describe("Whether this target request may already have reached the application. Omit when unknown."),
  retryAfterSeconds: z.number().int().min(0).max(86400).optional().describe("Parsed bounded Retry-After delay, if actually observed. Never submit the raw header."),
}).refine((input) => isSupportedClientVersion(input.client, input.version), {
  message: "Client and version must match the supported-client manifest.", path: ["version"],
});

export type DiagnosticsInput = z.input<typeof diagnosticsInputSchema>;

export const diagnosticsOutputSchema = z.strictObject({
  client: clientSchema,
  version: clientVersionSchema,
  rulesRevision: z.string(),
  evidence: diagnosticsInputSchema,
  summary: z.string(),
  candidates: z.array(z.strictObject({ code: z.string(), confidence: z.enum(["supported", "possible"]), explanation: z.string(), nextCheck: z.string() })).min(1).max(5),
  uncertainty: z.array(z.string()).max(6),
  retry: z.strictObject({ automaticRetryRecommended: z.literal(false), category: z.enum(["reconcile_before_repeating", "bounded_retry_after_cause_check"]), advice: z.string() }),
  sources: z.array(z.url()).max(6),
});

type Candidate = { code: string; confidence: "supported" | "possible"; explanation: string; nextCheck: string };

const source = {
  status: "https://ipvolt.com/blog/proxy-status-codes-407-429-502",
  auth: "https://ipvolt.com/guides/fix-proxy-error-407",
  timeout: "https://ipvolt.com/guides/proxy-timeout-troubleshooting",
  pool: "https://ipvolt.com/guides/httpx-async-proxy",
  retry: "https://ipvolt.com/blog/proxy-retries-duplicate-jobs",
  routing: "https://ipvolt.com/guides/proxy-environment-variables",
};

export function diagnoseProxyError(input: unknown) {
  const parsed = diagnosticsInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid diagnostic input. Use an exact supported client/version and normalized bounded evidence; do not submit logs, URLs or credentials.");
  const evidence = parsed.data;
  const candidates: Candidate[] = [];
  const sources = new Set<string>();
  const uncertainty = ["These are interpretations of the supplied observations, not a live network test or proof of the root cause."];
  const add = (candidate: Candidate, url: string) => { candidates.push(candidate); sources.add(url); };

  if (evidence.status === 407) {
    add({ code: "proxy_authentication_required", confidence: "supported", explanation: "407 reports an intermediary authentication requirement. It does not identify a wrong password as the sole cause.", nextCheck: "Confirm the responding proxy, documented authentication scheme, gateway/port, account access and how credentials reach this client's proxy option. Inspect only redacted authentication metadata." }, source.auth);
    if (evidence.responseSource === "target") uncertainty.push("A response labeled target with status 407 needs provenance review: an intermediary or nested upstream may have supplied that response.");
  }
  if (evidence.status === 429) {
    add({ code: "rate_limit", confidence: "supported", explanation: "The responding layer reports rate limiting; the status alone does not identify which account, quota or resource is limited.", nextCheck: evidence.retryAfterSeconds === undefined ? "Identify the responding layer, inspect documented rate limits and parse Retry-After if present. Reduce concurrency before another bounded attempt." : `Identify the responding layer and its documented limit. Honor the observed Retry-After delay of at least ${evidence.retryAfterSeconds} seconds, subject to the request's deadline and retry safety.` }, source.status);
  }
  if (evidence.status === 502 || evidence.status === 503 || evidence.status === 504) {
    add({ code: "gateway_or_service_failure", confidence: "supported", explanation: `${evidence.status} reports a gateway/service failure or unavailability. An HTTP status alone cannot attribute it to the proxy supplier, target or application.`, nextCheck: "Identify the responding layer and compare connect/tunnel/TLS/response timings for one controlled request. Check service health and documented limits before choosing a bounded retry." }, source.status);
  }
  if (evidence.status === 401 || evidence.status === 403) {
    add({ code: "access_rejected", confidence: "supported", explanation: `${evidence.status} is an authentication/access rejection from the responding layer; it is not by itself evidence of a broken proxy.`, nextCheck: "Establish response provenance and the authorized access requirements. Keep proxy credentials separate from target credentials; do not bypass an access restriction." }, source.status);
  }
  if (evidence.exception === "pool_timeout" || evidence.phase === "pool") {
    add({ code: "local_pool_contention", confidence: evidence.exception === "pool_timeout" ? "supported" : "possible", explanation: "Pool waiting happens inside the client before this attempt acquires a connection. It is distinct from the proxy's connection latency.", nextCheck: "Check connection limits, concurrency and response cleanup. Close streamed responses on all exit paths and test one request with concurrency set to one." }, source.pool);
    if (evidence.client !== "httpx") uncertainty.push("The pool category is normalized evidence; this toolkit has only verified the named PoolTimeout behavior in HTTPX. Confirm the originating client's actual exception.");
  }
  if (evidence.exception === "tls_error" || evidence.phase === "target_tls") {
    add({ code: "tls_verification_or_handshake", confidence: evidence.exception === "tls_error" ? "supported" : "possible", explanation: "TLS failure may involve certificate trust, hostname matching, interception, protocol support or a tunnel that was never established.", nextCheck: "First verify CONNECT success, then inspect a redacted certificate chain, target hostname and trusted CA configuration. Keep certificate and hostname verification enabled." }, source.timeout);
  }
  if (evidence.exception === "connect_timeout" || evidence.exception === "connection_refused" || evidence.exception === "dns_error") {
    add({ code: "connection_establishment", confidence: "supported", explanation: "Connection establishment failed or exceeded its budget. The relevant host depends on which phase failed and which component resolves DNS.", nextCheck: "Separate local-to-proxy DNS/TCP from proxy-to-target CONNECT. Confirm the configured scheme/port and network policy with one bounded test; do not silently fall back to a direct request." }, source.timeout);
  }
  if (evidence.exception === "read_timeout" || evidence.exception === "write_timeout" || evidence.exception === "timeout" || evidence.exception === "connection_reset") {
    add({ code: "request_outcome_may_be_unknown", confidence: "possible", explanation: "A timeout or reset can occur after a request reached the application. The absence of a complete response does not prove that the operation was not applied.", nextCheck: "Record the last completed phase and whether this is the first attempt. Reconcile application state or use a documented stable idempotency key before repeating a write." }, source.retry);
  }
  if (evidence.exception === "proxy_error" || evidence.phase === "connect_tunnel") {
    add({ code: "proxy_tunnel_failure", confidence: evidence.exception === "proxy_error" ? "supported" : "possible", explanation: "Proxy/tunnel setup may fail because of authentication, gateway configuration, target policy or an upstream connection failure.", nextCheck: "Inspect the CONNECT status and the documented gateway protocol with secrets removed. A generic proxy exception alone does not distinguish these causes." }, source.auth);
  }
  if (evidence.exception === "protocol_error" || evidence.exception === "invalid_configuration" || evidence.phase === "configuration") {
    add({ code: "configuration_or_protocol_mismatch", confidence: "possible", explanation: "A malformed option, incompatible API/version or unexpected protocol exchange may prevent the intended proxy route from being used.", nextCheck: "Compare the exact installed client version with a tested template. Check the proxy scheme, target scheme, explicit proxy option and NO_PROXY behavior without sharing the URL or credentials." }, source.routing);
  }
  if (evidence.status !== undefined && evidence.status >= 200 && evidence.status < 400) {
    add({ code: "response_is_not_content_or_route_proof", confidence: "supported", explanation: "A successful or redirect status does not establish that the content is usable or that the intended proxy carried the request.", nextCheck: "Validate application-specific content separately and use an explicitly scoped route check. Do not follow a redirect automatically while isolating a routing failure." }, source.status);
  }
  if (candidates.length === 0) {
    add({ code: "insufficient_evidence", confidence: "possible", explanation: "The supplied fields do not distinguish an authentication, connection, TLS, application or client-resource failure.", nextCheck: "Supply the last completed phase, a normalized exception or status and established response provenance. Keep all logs, URLs, headers and credentials local." }, source.timeout);
  }
  if (evidence.responseSource === "unknown" && evidence.status !== undefined) uncertainty.push("The responding layer has not been established. Do not attribute this status to the target or proxy supplier yet.");
  if (evidence.phase === "unknown") uncertainty.push("The failed phase is unknown, so a client-wide timeout cannot identify a specific network segment.");
  if (evidence.requestMayHaveBeenSent === false && ["request_send", "response_headers", "response_body"].includes(evidence.phase)) uncertainty.push("The supplied phase conflicts with certainty that no request was sent. Treat the application outcome as unknown until reconciled.");
  if (evidence.phase === "pool" && evidence.requestMayHaveBeenSent === true) uncertainty.push("Pool waiting and a sent request may describe different attempts. Separate them before applying retry advice.");

  const potentiallyMutating = !["GET", "HEAD", "OPTIONS"].includes(evidence.method);
  const retry = potentiallyMutating ? {
    automaticRetryRecommended: false,
    category: "reconcile_before_repeating",
    advice: "Do not automatically repeat POST/PATCH or an operation of unknown semantics. Even PUT/DELETE require a verified application contract. Reconcile state or use the application's documented idempotency mechanism; a timeout, gateway status or failed response is not proof that no change occurred.",
  } : {
    automaticRetryRecommended: false,
    category: "bounded_retry_after_cause_check",
    advice: "GET/HEAD/OPTIONS are intended to be safe methods, but verify the actual endpoint's semantics. Resolve permanent configuration/authentication failures first; use a small attempt budget, deadline and backoff, and honor an observed Retry-After. This tool does not execute retries.",
  };
  sources.add(source.retry);
  return diagnosticsOutputSchema.parse({
    client: evidence.client,
    version: evidence.version,
    rulesRevision: "2026-09-14.1",
    evidence,
    summary: candidates[0]!.explanation,
    candidates: candidates.slice(0, 5),
    uncertainty,
    retry,
    sources: [...sources],
  });
}
