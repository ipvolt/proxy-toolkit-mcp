import { createChecker } from '../../src/local/route-runtime.js';

try {
  if (process.env.TEST_UNSAFE_ENV_NAME) {
    process.env[process.env.TEST_UNSAFE_ENV_NAME] = process.env.TEST_UNSAFE_ENV_VALUE;
  }
  if (process.env.TEST_CLEAR_NODE_DEBUG === '1') delete process.env.NODE_DEBUG;
  const checker = createChecker({ enabled: true, proxyUrl: process.env.TEST_PROXY_URL }, {
    endpoint: process.env.TEST_ECHO_ENDPOINT!,
    timeoutMs: 1_000,
    ca: process.env.TEST_ECHO_CA,
  });
  process.stdout.write(JSON.stringify(await checker({ profile: 'default' })));
} catch (error) {
  // Exercise the complete exception surface, including stack and own properties.
  process.stderr.write(String(error) + '\n' + (error instanceof Error ? error.stack : '') + '\n' + JSON.stringify(error));
  process.exitCode = 1;
}
