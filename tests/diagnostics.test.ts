import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseProxyError, diagnosticsInputSchema, diagnosticsOutputSchema } from "../src/core/diagnostics.js";

const client = { client: "httpx", version: "0.28.1" } as const;

test("407 distinguishes authentication evidence from a password conclusion", () => {
  const result = diagnoseProxyError({ ...client, phase: "connect_tunnel", status: 407, exception: "proxy_error", method: "GET" });
  assert.ok(diagnosticsOutputSchema.safeParse(result).success);
  assert.equal(result.candidates[0]?.code, "proxy_authentication_required");
  assert.match(result.summary, /not identify a wrong password as the sole cause/);
  assert.ok(result.uncertainty.some((text) => text.includes("responding layer")));
  assert.equal(result.retry.automaticRetryRecommended, false);
});

test("timeout after sending a POST requires reconciliation even if supplied evidence denies sending", () => {
  const result = diagnoseProxyError({ ...client, phase: "response_headers", exception: "read_timeout", method: "POST", requestMayHaveBeenSent: false });
  assert.equal(result.retry.category, "reconcile_before_repeating");
  assert.match(result.retry.advice, /idempotency/);
  assert.ok(result.uncertainty.some((text) => text.includes("conflicts")));
  assert.ok(result.sources.includes("https://ipvolt.com/blog/proxy-retries-duplicate-jobs"));
});

test("PoolTimeout points at local capacity and cleanup, not a slow supplier", () => {
  const result = diagnoseProxyError({ ...client, phase: "pool", exception: "pool_timeout", method: "GET" });
  assert.equal(result.candidates[0]?.code, "local_pool_contention");
  assert.match(result.summary, /distinct from the proxy's connection latency/);
  assert.match(result.candidates[0]!.nextCheck, /Close streamed responses/);
});

test("429 preserves Retry-After as evidence without automatically retrying", () => {
  const result = diagnoseProxyError({ ...client, phase: "response_headers", status: 429, retryAfterSeconds: 45, method: "GET" });
  assert.equal(result.candidates[0]?.code, "rate_limit");
  assert.match(result.candidates[0]!.nextCheck, /at least 45 seconds/);
  assert.equal(result.retry.automaticRetryRecommended, false);
});

test("TLS next check retains verification, while successful HTTP is not route proof", () => {
  const tls = diagnoseProxyError({ ...client, phase: "target_tls", exception: "tls_error" });
  assert.match(tls.candidates[0]!.nextCheck, /verification enabled/);
  const success = diagnoseProxyError({ ...client, phase: "response_headers", status: 200, method: "GET", responseSource: "target" });
  assert.equal(success.candidates[0]?.code, "response_is_not_content_or_route_proof");
});

test("missing evidence and mutating idempotent methods are handled conservatively", () => {
  const result = diagnoseProxyError({ ...client, phase: "unknown" });
  assert.equal(result.candidates[0]?.code, "insufficient_evidence");
  assert.equal(result.retry.category, "reconcile_before_repeating");
  const put = diagnoseProxyError({ ...client, phase: "response_headers", status: 504, method: "PUT" });
  assert.match(put.retry.advice, /PUT\/DELETE require a verified application contract/);
});

test("diagnostics reject credentials, unrestricted evidence and unsupported versions without echoing input", () => {
  for (const extra of [
    { logs: "secret-sentinel" },
    { url: "http://private-sentinel:secret-sentinel@localhost" },
    { exception: "raw-secret-sentinel" },
    { status: 600 },
    { retryAfterSeconds: -1 },
    { retryAfterSeconds: 86401 },
    { retryAfterSeconds: Number.NaN },
    { version: "2.34.2" },
    { phase: "unknown-secret-sentinel" },
  ]) {
    const input = { ...client, phase: "unknown", ...extra };
    assert.equal(diagnosticsInputSchema.safeParse(input).success, false);
    assert.throws(() => diagnoseProxyError(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid diagnostic input/);
      assert.doesNotMatch(error.message, /sentinel/);
      return true;
    });
  }
});
