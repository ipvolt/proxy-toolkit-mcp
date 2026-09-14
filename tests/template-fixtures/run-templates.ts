/**
 * Executes generated code without editing it. Requires the pinned external test
 * clients documented in this directory; no dependency is downloaded by this test.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { once } from "node:events";
import { generateProxyConfig, SUPPORTED_CLIENTS } from "../../src/core/config.js";

const python = process.env.IPVOLT_TEMPLATE_PYTHON;
const playwrightModules = process.env.IPVOLT_TEMPLATE_PLAYWRIGHT_MODULES;
const curl = process.env.IPVOLT_TEMPLATE_CURL || "curl";
if (!python || !playwrightModules) throw new Error("Set IPVOLT_TEMPLATE_PYTHON and IPVOLT_TEMPLATE_PLAYWRIGHT_MODULES to the pinned fixture dependencies.");
assert.equal(process.version, "v24.20.0", "Use the tested Node runtime when refreshing the manifest.");
assert.match(execFileSync(curl, ["--version"], { encoding: "utf8" }), /^curl 8\.22\.0 /);
const pythonVersions = JSON.parse(execFileSync(python, ["-c", "import json, platform, requests, httpx; print(json.dumps([platform.python_version(), requests.__version__, httpx.__version__]))"], { encoding: "utf8" }));
assert.deepEqual(pythonVersions, ["3.14.7", "2.34.2", "0.28.1"]);
const playwrightPackage = JSON.parse(await readFile(join(playwrightModules, "playwright/package.json"), "utf8"));
assert.equal(playwrightPackage.version, "1.63.0");

const temporary = await mkdtemp(join(tmpdir(), "ipvolt-mcp-template-fixture-"));
const sockets = new Set<Socket>();
const certificate = join(temporary, "certificate.pem");
const key = join(temporary, "key.pem");
const config = join(temporary, "openssl.cnf");
let connections = 0;
let refusedAuthentication = 0;
const paths: string[] = [];
const username = "fixture-user-sentinel";
const password = "fixture-password-sentinel:@/";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const origin = createHttpsServer();
const proxy = createHttpServer();

function track(socket: Socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

async function run(command: string, args: string[], environment: NodeJS.ProcessEnv) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }>((resolveResult, reject) => {
    const start = performance.now();
    // Deliberately exclude parent credentials, debug flags and unrelated config.
    const child = spawn(command, args, { cwd: temporary, env: { PATH: isAbsolute(curl) ? `${dirname(curl)}:${process.env.PATH || ""}` : process.env.PATH, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const kill = setTimeout(() => child.kill("SIGKILL"), 6000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; if (stdout.length > 8192) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; if (stderr.length > 8192) child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(kill);
      try {
        const output = stdout + stderr;
        assert.doesNotMatch(output, /fixture-user-sentinel|fixture-password-sentinel/);
        assert.ok(output.length < 4096, "Only bounded output should be emitted.");
        resolveResult({ code, stdout, stderr, elapsedMs: performance.now() - start });
      } catch (error) { reject(error); }
    });
  });
}

try {
  await writeFile(config, `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = ext\n[dn]\nCN = localhost\n[ext]\nsubjectAltName = DNS:localhost,IP:127.0.0.1\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,digitalSignature,keyEncipherment,keyCertSign\n`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-days", "1", "-config", config], { stdio: "ignore" });
  origin.setSecureContext({ key: await readFile(key), cert: await readFile(certificate) });
  origin.on("connection", track);
  origin.on("tlsClientError", () => {});
  origin.on("request", (request, response) => {
    paths.push(request.url || "");
    if (request.url === "/hang") return;
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/redirected", "Content-Length": 0 });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 2 });
    response.end("ok");
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originAddress = origin.address();
  assert.ok(originAddress && typeof originAddress !== "string");
  const targetAuthority = `127.0.0.1:${originAddress.port}`;
  const target = `https://${targetAuthority}`;
  proxy.on("connection", track);
  proxy.on("request", (_request, response) => { response.writeHead(502); response.end(); });
  proxy.on("connect", (request, client, head) => {
    track(client);
    connections += 1;
    if (request.headers["proxy-authorization"] !== authorization) {
      refusedAuthentication += 1;
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    if (request.url !== targetAuthority) {
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = track(connect(originAddress.port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    }));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== "string");
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${proxyAddress.port}`;
  const wrongProxyUrl = `http://${username}:wrong-password@127.0.0.1:${proxyAddress.port}`;
  await symlink(resolve(playwrightModules), join(temporary, "node_modules"), "dir");

  const closedPort = createTcpServer();
  closedPort.listen(0, "127.0.0.1");
  await once(closedPort, "listening");
  const closedAddress = closedPort.address();
  assert.ok(closedAddress && typeof closedAddress !== "string");
  await new Promise<void>((resolveClose) => closedPort.close(() => resolveClose()));
  const unavailableProxy = `http://127.0.0.1:${closedAddress.port}`;

  for (const manifest of SUPPORTED_CLIENTS) {
    const generated = generateProxyConfig({ client: manifest.client, version: manifest.version, timeoutSeconds: 1 });
    const extension = manifest.language === "python" ? "py" : manifest.language === "sh" ? "sh" : "mjs";
    const path = join(temporary, `proxy_${manifest.client}.${extension}`);
    await writeFile(path, generated.code);
    const command = manifest.client === "curl" ? "/bin/sh" : manifest.language === "python" ? python : process.execPath;
    const env = {
      PROXY_URL: proxyUrl, TARGET_URL: `${target}/ok`,
      CURL_CA_BUNDLE: certificate, TARGET_CA_BUNDLE: certificate, NODE_EXTRA_CA_CERTS: certificate,
      // Hostile ambient routing settings must not override the selected proxy.
      HTTP_PROXY: unavailableProxy, HTTPS_PROXY: unavailableProxy, ALL_PROXY: unavailableProxy,
      http_proxy: unavailableProxy, https_proxy: unavailableProxy, all_proxy: unavailableProxy,
      NO_PROXY: "*", no_proxy: "*",
    };
    const beforeSuccess = connections;
    const success = await run(command, [path], env);
    assert.equal(success.code, 0, `${manifest.client} success: ${success.stderr}`);
    assert.equal(JSON.parse(success.stdout).status, 200);
    assert.ok(connections > beforeSuccess, "The configured CONNECT proxy must see the successful request.");

    const redirect = await run(command, [path], { ...env, TARGET_URL: `${target}/redirect` });
    assert.equal(redirect.code, 0, `${manifest.client} redirect: ${redirect.stderr}`);
    assert.equal(JSON.parse(redirect.stdout).status, 302);
    assert.equal(paths.filter((value) => value === "/redirected").length, 0);

    const before407 = paths.length;
    const authentication = await run(command, [path], { ...env, PROXY_URL: wrongProxyUrl });
    // APIRequestContext may expose the proxy's 407 as a response rather than throw.
    assert.ok(authentication.code !== 0 || JSON.parse(authentication.stdout).status === 407, `${manifest.client} must report proxy authentication rejection.`);
    assert.equal(paths.length, before407, "407 must not reach the origin or fall back directly.");

    const beforeUnavailable = paths.length;
    const unavailable = await run(command, [path], { ...env, PROXY_URL: unavailableProxy });
    assert.notEqual(unavailable.code, 0);
    assert.equal(paths.length, beforeUnavailable, "An unavailable proxy must never fall back to a direct request.");

    const untrustedEnvironment: NodeJS.ProcessEnv = { ...env };
    delete untrustedEnvironment.CURL_CA_BUNDLE;
    delete untrustedEnvironment.TARGET_CA_BUNDLE;
    delete untrustedEnvironment.NODE_EXTRA_CA_CERTS;
    const beforeTls = paths.length;
    const untrusted = await run(command, [path], untrustedEnvironment);
    assert.notEqual(untrusted.code, 0, `${manifest.client} must reject an untrusted target certificate.`);
    assert.equal(paths.length, beforeTls);

    const timeout = await run(command, [path], { ...env, TARGET_URL: `${target}/hang` });
    assert.notEqual(timeout.code, 0);
    assert.ok(timeout.elapsedMs < 5000, `${manifest.client} should exit after the bounded response timeout.`);

    const invalid = await run(command, [path], { ...env, PROXY_URL: "socks5://fixture-user-sentinel:fixture-password-sentinel@127.0.0.1:1" });
    assert.notEqual(invalid.code, 0);
    if (manifest.client === "playwright") {
      const beforeDebug = connections;
      for (const dangerous of [
        { DEBUG: "pw:*" },
        { DEBUG: "pw:api" },
        { NODE_DEBUG: "http" },
        { NODE_DEBUG_NATIVE: "TLSWRAP" },
        { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        { NODE_OPTIONS: "--trace-tls" },
        { NODE_OPTIONS: `--tls-keylog=${join(temporary, "must-not-exist.keys")}` },
      ]) {
        const guarded = await run(command, [path], { ...env, ...dangerous });
        assert.equal(guarded.code, 1);
        assert.equal(guarded.stdout, "");
        assert.equal(JSON.parse(guarded.stderr).error, "unsafe_debug_environment");
      }
      assert.equal(connections, beforeDebug, "Unsafe debug/TLS settings must be rejected before network access.");
      console.log(JSON.stringify({ client: manifest.client, additionalCheck: "debug_and_TLS_guard", cases: 7, networkRequests: 0 }));
    }
    console.log(JSON.stringify({ client: manifest.client, version: manifest.version, runtime: manifest.runtime, checks: ["authenticated_CONNECT", "ambient_proxy_and_NO_PROXY_override", "no_redirect", "407_without_fallback", "unavailable_proxy_without_fallback", "TLS_verification", "response_timeout", "unsupported_proxy_protocol", "credential_redaction"] }));
  }
  assert.ok(refusedAuthentication >= SUPPORTED_CLIENTS.length);
  console.log(JSON.stringify({ result: "pass", clients: SUPPORTED_CLIENTS.length, checksPerClient: 9, fixture: "localhost HTTPS origin and authenticated HTTP CONNECT proxy" }));
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise<void>((resolveClose) => origin.close(() => resolveClose())), new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))]);
  await rm(temporary, { recursive: true, force: true });
}
