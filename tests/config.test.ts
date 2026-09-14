import assert from "node:assert/strict";
import { test } from "node:test";
import { configInputSchema, configOutputSchema, generateProxyConfig, SUPPORTED_CLIENTS } from "../src/core/config.js";

test("every supported client has a structured, credential-free configuration", () => {
  for (const { client, version } of SUPPORTED_CLIENTS) {
    const result = generateProxyConfig({ client, version });
    assert.ok(configOutputSchema.safeParse(result).success);
    assert.equal(result.client, client);
    assert.equal(result.version, version);
    assert.equal(result.behavior.followsRedirects, false);
    assert.equal(result.behavior.automaticRetries, 0);
    assert.equal(result.behavior.verifiesTargetTls, true);
    assert.ok(result.code.includes("PROXY_URL"));
    assert.ok(result.code.includes("TARGET_URL"));
    assert.ok(result.sources.every((url) => url.startsWith("https://ipvolt.com/")));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16384);
  }
});

test("schema and direct function reject mismatched versions, nonfinite bounds and arbitrary keys", () => {
  const invalid: unknown[] = [
    { client: "httpx", version: "2.34.2" },
    { client: "requests", version: "latest" },
    { client: "httpx", version: "0.28.1", timeoutSeconds: 0 },
    { client: "httpx", version: "0.28.1", timeoutSeconds: 1.5 },
    { client: "httpx", version: "0.28.1", timeoutSeconds: Number.NaN },
    { client: "httpx", version: "0.28.1", timeoutSeconds: Infinity },
    { client: "httpx", version: "0.28.1", timeoutSeconds: 61 },
    { client: "httpx", version: "0.28.1", protocol: "socks5" },
    { client: "httpx", version: "0.28.1", proxyUrl: "http://private-sentinel:secret-sentinel@localhost:3128" },
    { client: "httpx", version: "0.28.1", "private-key-sentinel": "secret-sentinel" },
    null,
  ];
  for (const value of invalid) {
    assert.equal(configInputSchema.safeParse(value).success, false);
    assert.throws(() => generateProxyConfig(value), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid configuration input/);
      assert.doesNotMatch(error.message, /sentinel/);
      return true;
    });
  }
});

test("template settings preserve client-specific timeout and execution scope", () => {
  const curl = generateProxyConfig({ client: "curl", version: "8.22.0", timeoutSeconds: 1 });
  assert.match(curl.code, /--variable '%PROXY_URL' --expand-proxy/);
  assert.doesNotMatch(curl.code, /--proxy "\$PROXY_URL"/);
  assert.match(curl.code, /--connect-timeout 1 --max-time 1 --retry 0/);
  const requests = generateProxyConfig({ client: "requests", version: "2.34.2" });
  const httpx = generateProxyConfig({ client: "httpx", version: "0.28.1" });
  assert.match(requests.behavior.timeoutScope, /not a total/);
  assert.match(httpx.behavior.timeoutScope, /not a total/);
  const playwright = generateProxyConfig({ client: "playwright", version: "1.63.0" });
  assert.match(playwright.interface, /not browser/);
  assert.ok(playwright.limitations.some((text) => text.includes("buffers responses")));
  assert.ok(playwright.code.indexOf("if (unsafeEnvironment)") < playwright.code.indexOf("await import('playwright')"));
});
