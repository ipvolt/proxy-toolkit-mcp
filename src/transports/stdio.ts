#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createToolkitServer } from '../server.js';
import { createRouteChecker } from '../local/route-check.js';
import { VERSION } from '../meta.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { sanitizeProtocolMessage } from '../protocol-safety.js';

class SafeStdioTransport extends StdioServerTransport {
  override send(message:JSONRPCMessage):Promise<void>{return super.send(sanitizeProtocolMessage(message));}
}

function main():void {
  if (process.argv.length===3&&process.argv[2]==='--version') {process.stdout.write(VERSION+'\n');return;}
  if (process.argv.length===3&&process.argv[2]==='--help') {
    process.stdout.write('ipvolt-proxy-toolkit [--help | --version]\n\nDefault: serve four public tools over MCP stdio.\nOptional local route check: IPVOLT_ENABLE_ROUTE_CHECK=1 and privately set IPVOLT_PROXY_URL.\nProxy HTTP CONNECT only; fixed https://mcp.ipvolt.com/egress destination.\nNever put credentials in tool arguments.\n');return;
  }
  if (process.argv.length!==2) throw new Error('Unsupported command-line arguments');
  const flag=process.env.IPVOLT_ENABLE_ROUTE_CHECK;
  if (flag!==undefined&&flag!=='0'&&flag!=='1') throw new Error('Invalid route enable flag');
  const checker=flag==='1'?createRouteChecker({enabled:true,proxyUrl:process.env.IPVOLT_PROXY_URL}):undefined;
  const handle=serveStdio(()=>createToolkitServer({routeChecker:checker}),{
    legacy:'serve',maxSubscriptions:0,
    transport:new SafeStdioTransport(process.stdin,process.stdout,{maxBufferSize:32_768}),
    onerror:()=>process.stderr.write('MCP transport rejected an invalid request.\n'),
  });
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void handle.close().then(()=>process.exit(0)));
}
try {main();} catch {
  process.stderr.write('Unable to start ipvolt Proxy Toolkit. Check the documented local configuration and debug-environment restrictions.\n');
  process.exitCode=1;
}
