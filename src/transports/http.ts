import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createToolkitServer, type ToolMetric } from '../server.js';
import { loadPublicCatalog } from '../core/catalog.js';
import { PUBLIC_MCP_URL, SERVER_NAME, VERSION } from '../meta.js';
import { sanitizeProtocolResponse } from '../protocol-safety.js';

const MAX_BODY=32_768;
const HTTP_METHODS=new Set(['initialize','notifications/initialized','notifications/cancelled','ping','server/discover','tools/list','tools/call','resources/list','resources/templates/list','prompts/list']);
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const NONCE=/^[a-f0-9]{32}$/;
export type HttpOptions={
  publicUrl?:string; allowedOrigins?:string[]; trustProxy?:boolean;
  requestsPerMinute?:number; maxClients?:number; maxConcurrent?:number;
  onToolComplete?:(metric:ToolMetric)=>void;
};
class HttpFailure extends Error {constructor(readonly status:number, message:string){super(message);}}

class RateLimiter {
  private readonly entries=new Map<string,{count:number;expires:number}>();
  private readonly secret=randomBytes(32);
  private readonly cleanup:NodeJS.Timeout;
  constructor(private readonly limit:number,private readonly maxKeys:number) {
    this.cleanup=setInterval(()=>this.prune(Date.now()),1000);this.cleanup.unref();
  }
  private prune(now:number) {for(const [key,entry] of this.entries) if(entry.expires<=now)this.entries.delete(key);}
  allow(address:string):boolean {
    const now=Date.now();this.prune(now);
    const key=createHmac('sha256',this.secret).update(address).digest('hex');
    const entry=this.entries.get(key);
    if(entry){if(entry.count>=this.limit)return false;entry.count++;return true;}
    if(this.entries.size>=this.maxKeys)return false;
    this.entries.set(key,{count:1,expires:now+60_000});return true;
  }
  close(){clearInterval(this.cleanup);this.entries.clear();this.secret.fill(0);}
}
function json(res:ServerResponse,status:number,body:unknown,close=false):void {
  if(res.writableEnded||res.destroyed)return;
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(close)res.setHeader('Connection','close');
  res.end(JSON.stringify(body));
}
function header(req:IncomingMessage,name:string):string|undefined {
  const values=req.headersDistinct[name];
  if(values&&values.length!==1)throw new HttpFailure(400,'Duplicate request header');
  return values?.[0];
}
function clientAddress(req:IncomingMessage,trustProxy:boolean):string {
  const peer=req.socket.remoteAddress??'';
  if(!isIP(peer))throw new HttpFailure(400,'Missing connection address');
  if(!trustProxy)return peer;
  if(!LOOPBACK.has(peer))throw new HttpFailure(403,'Untrusted reverse proxy');
  // Caddy must OVERWRITE this header with its actual remote socket address.
  const address=header(req,'x-ipvolt-peer');
  if(!address||!isIP(address))throw new HttpFailure(400,'Missing trusted connection address');
  return address;
}
async function readJson(req:IncomingMessage):Promise<Record<string,unknown>> {
  const contentType=header(req,'content-type');
  if(!contentType||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))throw new HttpFailure(415,'Use application/json');
  const encoding=header(req,'content-encoding');
  if(encoding&&encoding!=='identity')throw new HttpFailure(415,'Encoded request bodies are unsupported');
  const length=header(req,'content-length');
  if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY))throw new HttpFailure(413,'Request is too large');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);
    size+=bytes.length;if(size>MAX_BODY)throw new HttpFailure(413,'Request is too large');
    chunks.push(bytes);
  }
  try {
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
    return value as Record<string,unknown>;
  }catch{throw new HttpFailure(400,'One valid JSON-RPC object is required');}
}

export function createHttpService(options:HttpOptions={}) {
  const publicUrl=new URL(options.publicUrl??PUBLIC_MCP_URL);
  if(publicUrl.pathname!=='/mcp'||publicUrl.search||publicUrl.hash||publicUrl.username||publicUrl.password)throw new Error('Invalid public MCP URL');
  if(publicUrl.protocol!=='https:'&&!(publicUrl.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(publicUrl.hostname)))throw new Error('Public MCP URL requires HTTPS');
  const origins=new Set(options.allowedOrigins??[publicUrl.origin,'https://ipvolt.com']);
  for(const origin of origins)if(new URL(origin).origin!==origin||!/^https?:/.test(origin))throw new Error('Invalid allowed origin');
  const hosts=new Set([publicUrl.hostname,'localhost','127.0.0.1','[::1]']);
  const limit=options.requestsPerMinute??120,maxClients=options.maxClients??1024,maxConcurrent=options.maxConcurrent??16;
  if(![limit,maxClients,maxConcurrent].every(n=>Number.isInteger(n)&&n>0&&n<=10_000))throw new Error('Invalid resource limit');
  const catalog=loadPublicCatalog();
  // No local route checker is ever passed to the hosted factory.
  const mcp=createMcpHandler(()=>createToolkitServer({catalog,onToolComplete:options.onToolComplete}),{
    legacy:'stateless',onerror:()=>{},
  });
  const handleMcp=toNodeHandler({fetch:async(request,inputs)=>sanitizeProtocolResponse(await mcp.fetch(request,inputs))},{onerror:()=>{}});
  const limiter=new RateLimiter(limit,maxClients);
  let active=0;
  const server=createServer({maxHeaderSize:8192,requestTimeout:10_000,headersTimeout:5000,keepAliveTimeout:5000},(req,res)=>{
    const deadline=setTimeout(()=>{json(res,408,{error:'Request deadline reached'},true);if(!req.complete)req.destroy();},10_000);
    deadline.unref();
    res.once('close',()=>{clearTimeout(deadline);if(!req.complete)req.destroy();});
    res.once('finish',()=>clearTimeout(deadline));
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    void (async()=>{
      const host=header(req,'host');
      if(!host||!/^([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(host)||!hosts.has(new URL(`http://${host}`).hostname))throw new HttpFailure(403,'Invalid Host');
      const origin=header(req,'origin');
      if(origin!==undefined&&!origins.has(origin))throw new HttpFailure(403,'Origin is not allowed');
      if(origin!==undefined){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      const url=new URL(req.url??'/',publicUrl.origin);
      if(url.origin!==publicUrl.origin||!['/mcp','/egress','/healthz'].includes(url.pathname))throw new HttpFailure(404,'Not found');
      if(url.pathname==='/healthz'){
        if(!LOOPBACK.has(req.socket.remoteAddress??''))throw new HttpFailure(403,'Health check is local');
        if(options.trustProxy&&header(req,'x-ipvolt-peer')!==undefined&&!LOOPBACK.has(clientAddress(req,true)))throw new HttpFailure(403,'Health check is local');
        if(req.method!=='GET'||url.search)throw new HttpFailure(405,'Method not allowed');
        json(res,200,{ok:true,name:SERVER_NAME,version:VERSION,sourceRelease:catalog.provenance.sourceRelease});return;
      }
      const address=clientAddress(req,options.trustProxy??false);
      if(!limiter.allow(address)){res.setHeader('Retry-After','60');throw new HttpFailure(429,'Request limit reached');}
      if(req.method==='OPTIONS'){
        if(!origin)throw new HttpFailure(403,'A browser Origin is required');
        res.setHeader('Access-Control-Allow-Methods',url.pathname==='/mcp'?'POST, OPTIONS':'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Content-Type, MCP-Protocol-Version, MCP-Client-Capabilities, MCP-Client-Info, MCP-Method, MCP-Name');
        res.setHeader('Access-Control-Max-Age','600');res.writeHead(204);res.end();return;
      }
      if(url.pathname==='/egress'){
        if(req.method!=='GET')throw new HttpFailure(405,'Method not allowed');
        const nonce=url.searchParams.get('nonce');
        if(!nonce||!NONCE.test(nonce)||[...url.searchParams].length!==1)throw new HttpFailure(400,'Invalid diagnostic nonce');
        json(res,200,{ip:address,nonce});return;
      }
      if(url.search)throw new HttpFailure(400,'MCP endpoint does not accept query parameters');
      if(req.method!=='POST'){res.setHeader('Allow','POST, OPTIONS');throw new HttpFailure(405,'Use Streamable HTTP POST');}
      if(active>=maxConcurrent)throw new HttpFailure(503,'Server is busy');
      active++;
      let released=false;
      const release=()=>{if(!released){active--;released=true;}};
      res.once('close',release);res.once('finish',release);
      const body=await readJson(req);
      // This immutable toolkit has no subscriptions, sampling or arbitrary RPC extensions.
      if(typeof body.method==='string'&&!HTTP_METHODS.has(body.method)){
        json(res,200,{jsonrpc:'2.0',id:typeof body.id==='string'||typeof body.id==='number'?body.id:null,error:{code:-32601,message:'Method not found'}});return;
      }
      await handleMcp(req,res,body);
    })().catch(error=>{
      const status=error instanceof HttpFailure?error.status:500;
      json(res,status,{error:error instanceof HttpFailure?error.message:'Request could not be completed'},true);
    });
  });
  server.maxConnections=64;
  server.on('upgrade',(_req,socket)=>socket.destroy());
  return {server,close:async()=>{
    limiter.close();await mcp.close();
    if(server.listening)await new Promise<void>((resolve,reject)=>{
      server.close(error=>error?reject(error):resolve());server.closeAllConnections();
    });
  }};
}

function start():void {
  const value=process.env.IPVOLT_MCP_PORT??'3040';
  if(!/^\d{1,5}$/.test(value)||Number(value)<1024||Number(value)>65535)throw new Error('Invalid port');
  const trust=process.env.IPVOLT_MCP_TRUST_PROXY;
  if(trust!==undefined&&trust!=='0'&&trust!=='1')throw new Error('Invalid proxy trust setting');
  const service=createHttpService({
    publicUrl:process.env.IPVOLT_MCP_PUBLIC_URL,
    allowedOrigins:process.env.IPVOLT_MCP_ALLOWED_ORIGINS?.split(',').map(value=>value.trim()),
    trustProxy:trust==='1',
    onToolComplete:metric=>process.stdout.write(JSON.stringify(metric)+'\n'),
  });
  service.server.listen(Number(value),'127.0.0.1',()=>process.stdout.write(JSON.stringify({event:'ready',version:VERSION})+'\n'));
  service.server.on('error',()=>{process.stderr.write('MCP HTTP listener failed.\n');process.exitCode=1;void service.close();});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void service.close().then(()=>process.exit(0)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{start();}catch{process.stderr.write('Unable to start MCP HTTP service. Check the documented configuration.\n');process.exitCode=1;}
}
