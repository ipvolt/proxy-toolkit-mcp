import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { configInputSchema, configOutputSchema, generateProxyConfig } from './core/config.js';
import { diagnosticsInputSchema, diagnosticsOutputSchema, diagnoseProxyError } from './core/diagnostics.js';
import { documentInputSchema, documentOutputSchema, searchInputSchema, searchOutputSchema, loadPublicCatalog, type PublicCatalog } from './core/catalog.js';
import { routeInputSchema, routeOutputSchema, type RouteChecker } from './local/route-check.js';
import { SERVER_NAME, VERSION } from './meta.js';
import { PUBLIC_ERRORS } from './protocol-safety.js';

export type ToolMetric = {tool:string; status:'ok'|'error'; durationMs:number; version:string};
export type ToolkitOptions = {catalog?:PublicCatalog; routeChecker?:RouteChecker; onToolComplete?:(metric:ToolMetric)=>void};
const readOnly = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};

export function createToolkitServer(options:ToolkitOptions = {}): McpServer {
  const catalog = options.catalog ?? loadPublicCatalog();
  const server = new McpServer({name:SERVER_NAME,version:VERSION,title:'ipvolt Proxy Toolkit',websiteUrl:'https://ipvolt.com/mcp'},{capabilities:{tools:{listChanged:false}}});
  async function invoke(tool:string, operation:()=>unknown|Promise<unknown>):Promise<CallToolResult> {
    const start=performance.now();
    let status:'ok'|'error'='error';
    try {
      const output=await operation();
      if (!output||typeof output!=='object'||Array.isArray(output)) throw new Error('Invalid tool result');
      const encoded=JSON.stringify(output);
      if (Buffer.byteLength(encoded)>32_000) throw new Error('Tool result exceeds its size limit');
      status=('ok' in output&&output.ok===false)?'error':'ok';
      return {content:[{type:'text',text:encoded}],structuredContent:output as Record<string,unknown>,...(status==='error'?{isError:true}:{})};
    } catch(error) {
      const message=error instanceof Error&&PUBLIC_ERRORS.has(error.message)?error.message:'The tool could not complete this request. Check the documented inputs and try again.';
      return {isError:true,content:[{type:'text',text:message}]};
    } finally {
      // Metrics contain no arguments, result bodies, credential/profile values or addresses.
      try {options.onToolComplete?.({tool,status,durationMs:Math.round(performance.now()-start),version:VERSION});} catch { /* Metrics cannot affect tool delivery. */ }
    }
  }
  server.registerTool('search_proxy_docs',{
    title:'Search reviewed proxy documentation',description:'Find reviewed ipvolt public guides and articles. Returns canonical document IDs, excerpts and content revision. Submit a short topic query, never credentials or logs.',
    inputSchema:searchInputSchema,outputSchema:searchOutputSchema,annotations:readOnly,
  }, input=>invoke('search_proxy_docs',()=>catalog.search(input)));
  server.registerTool('get_proxy_doc',{
    title:'Read a reviewed proxy document',description:'Read a bounded chunk or named section using a document ID returned by search_proxy_docs. Follow nextCursor to continue; cursors are bound to the content revision.',
    inputSchema:documentInputSchema,outputSchema:documentOutputSchema,annotations:readOnly,
  }, input=>invoke('get_proxy_doc',()=>catalog.get(input)));
  server.registerTool('generate_proxy_config',{
    title:'Generate a tested proxy configuration',description:'Generate an HTTPS GET example for an exact tested curl, Requests, HTTPX or Playwright APIRequestContext version. Credentials and target are local environment placeholders. It does not execute the example or configure other agent tools.',
    inputSchema:configInputSchema,outputSchema:configOutputSchema,annotations:readOnly,
  },input=>invoke('generate_proxy_config',()=>generateProxyConfig(input)));
  server.registerTool('diagnose_proxy_error',{
    title:'Diagnose a proxy error',description:'Use structured client/version, phase, status or exception observations to identify possible causes and the next check. Returns uncertainty and retry boundaries. Do not send raw logs, URLs or credentials.',
    inputSchema:diagnosticsInputSchema,outputSchema:diagnosticsOutputSchema,annotations:readOnly,
  },input=>invoke('diagnose_proxy_error',()=>diagnoseProxyError(input)));
  const checker=options.routeChecker;
  if (checker) server.registerTool('check_proxy_route',{
    title:'Check the locally configured proxy route',description:'Explicitly enabled local-only diagnostic: make one bounded HTTPS GET through the operator-configured HTTP proxy to the fixed ipvolt echo endpoint. Consumes a small amount of proxy bandwidth. Reports only this request; it does not test other agent tools or establish anonymity, location or proxy classification.',
    inputSchema:routeInputSchema,outputSchema:routeOutputSchema,
    annotations:{...readOnly,idempotentHint:false,openWorldHint:true},
  },(input,context)=>invoke('check_proxy_route',()=>checker(input,{signal:context.mcpReq.signal})));
  return server;
}
