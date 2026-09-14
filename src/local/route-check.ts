import { createChecker } from './route-runtime.js';

export {
  routeInputSchema,
  routeOutputSchema,
  RouteConfigurationError,
  RouteEnvironmentError,
  assertSafeRouteEnvironment,
  type RouteCheckInput,
  type RouteCheckResult,
  type RouteChecker,
  type RouteCheckOptions,
  type RouteOperatorConfig,
} from './route-runtime.js';

import type { RouteChecker, RouteOperatorConfig } from './route-runtime.js';

/** This endpoint is deliberately not configurable through tool arguments or env. */
export const ROUTE_ECHO_ENDPOINT = 'https://mcp.ipvolt.com/egress';

/** Creating a checker validates local configuration but never starts a request. */
export function createRouteChecker(config: RouteOperatorConfig): RouteChecker {
  return createChecker(
    { enabled: config.enabled, proxyUrl: config.proxyUrl },
    { endpoint: ROUTE_ECHO_ENDPOINT, timeoutMs: 10_000 },
  );
}
