#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createToolkitServer } from '../server.js';
import { createRouteChecker } from '../local/route-check.js';
import { readAccountConfig } from '../account/client.js';
import { createAccountTools, createSandboxTools } from '../account/tools.js';
import { readSandboxFlag, SandboxConfigurationError } from '../account/sandbox.js';
import { VERSION } from '../meta.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { sanitizeProtocolMessage } from '../protocol-safety.js';

class SafeStdioTransport extends StdioServerTransport {
  override send(message:JSONRPCMessage):Promise<void>{return super.send(sanitizeProtocolMessage(message));}
}

function main():void {
  if (process.argv.length===3&&process.argv[2]==='--version') {process.stdout.write(VERSION+'\n');return;}
  if (process.argv.length===3&&process.argv[2]==='--help') {
    process.stdout.write('ipvolt-proxy-toolkit [--help | --version]\n\nDefault: serve four public tools over MCP stdio.\nOptional local route check: IPVOLT_ENABLE_ROUTE_CHECK=1 and privately set IPVOLT_PROXY_URL.\nProxy HTTP CONNECT only; fixed https://mcp.ipvolt.com/egress destination.\nOptional account tools: privately set IPVOLT_API_KEY to an ipvolt API key.\nRenting and extending spend the prepaid balance and need confirmation.\nTry the account tools without an account: IPVOLT_SANDBOX=1 (no key). Simulated, no network, nothing charged.\nNever put credentials in tool arguments.\n');return;
  }
  if (process.argv.length!==2) throw new Error('Unsupported command-line arguments');
  const flag=process.env.IPVOLT_ENABLE_ROUTE_CHECK;
  if (flag!==undefined&&flag!=='0'&&flag!=='1') throw new Error('Invalid route enable flag');
  const checker=flag==='1'?createRouteChecker({enabled:true,proxyUrl:process.env.IPVOLT_PROXY_URL}):undefined;
  // Account tools exist only here: with a key, or in sandbox mode on a simulated account that makes no request.
  // The two never combine. One instance keeps rent/extend previews (and the sandbox account) for the whole session.
  const sandbox=readSandboxFlag(process.env);
  const config=sandbox?undefined:readAccountConfig(process.env);
  const account=sandbox?createSandboxTools():config?createAccountTools(config):undefined;
  const handle=serveStdio(()=>createToolkitServer({routeChecker:checker,account}),{
    legacy:'serve',maxSubscriptions:0,
    transport:new SafeStdioTransport(process.stdin,process.stdout,{maxBufferSize:32_768}),
    onerror:()=>process.stderr.write('MCP transport rejected an invalid request.\n'),
  });
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void handle.close().then(()=>process.exit(0)));
}
try {main();} catch(error) {
  // Only the sandbox refusal names its cause: its messages are constants and hold no environment value.
  process.stderr.write(error instanceof SandboxConfigurationError
    ?`Unable to start ipvolt Proxy Toolkit. ${error.message}\n`
    :'Unable to start ipvolt Proxy Toolkit. Check the documented local configuration and debug-environment restrictions.\n');
  process.exitCode=1;
}
