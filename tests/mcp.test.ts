import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHttpService } from '../src/transports/http.js';
import { SUPPORTED_CLIENTS } from '../src/core/config.js';

function data(result:unknown):Record<string,any>{
  const value=result as {structuredContent?:Record<string,any>;content?:{text?:string}[];isError?:boolean};
  assert.notEqual(value.isError,true,JSON.stringify(value));
  return value.structuredContent??JSON.parse(value.content?.[0]?.text??'null');
}
async function exercise(client:Client){
  const list=await client.listTools();
  assert.deepEqual(list.tools.map(t=>t.name).sort(),['search_proxy_docs','get_proxy_doc','generate_proxy_config','diagnose_proxy_error'].sort());
  assert.equal(client.getServerCapabilities()?.tools?.listChanged,false);
  for(const tool of list.tools){assert.equal(tool.inputSchema.type,'object');assert.equal(tool.outputSchema?.type,'object');}
  const search=data(await client.callTool({name:'search_proxy_docs',arguments:{query:'curl proxy',topic:'setup'}}));
  assert.ok(search.results.some((doc:any)=>doc.id==='/guides/curl-proxy-setup'));
  assert.equal(search.provenance.sourceRelease,'20260914-hero-split');
  for(const entry of SUPPORTED_CLIENTS){
    const config=data(await client.callTool({name:'generate_proxy_config',arguments:{client:entry.client,version:entry.version}}));
    assert.equal(config.client,entry.client);assert.ok(config.code.includes('PROXY_URL'));
  }
  const diagnosis=data(await client.callTool({name:'diagnose_proxy_error',arguments:{client:'httpx',version:'0.28.1',phase:'proxy_connect',status:407}}));
  assert.ok(JSON.stringify(diagnosis).includes('407'));
  await assert.rejects(client.callTool({name:'check_proxy_route',arguments:{profile:'default'}}),error=>{
    assert.ok(!String(error).includes('default'));return true;
  });
}

for(const version of ['2025-11-25','2026-07-28'] as const){
  test(`compiled entry contract over stdio (${version})`,async()=>{
    const client=new Client({name:'fixture-stdio',version:'1.0.0'},{supportedProtocolVersions:[version],versionNegotiation:{mode:version==='2026-07-28'?{pin:version}:'legacy'}});
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/transports/stdio.js')],stderr:'pipe'});
    let stderr='';transport.stderr?.on('data',chunk=>stderr+=chunk.toString());
    try{await client.connect(transport);await exercise(client);assert.equal(stderr,'');}finally{await client.close();}
  });
  test(`real HTTP client (${version})`,async()=>{
    const metrics:unknown[]=[];
    const service=createHttpService({publicUrl:'http://127.0.0.1/mcp',onToolComplete:metric=>metrics.push(metric)});
    service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
    const address=service.server.address();assert.ok(address&&typeof address!=='string');
    const client=new Client({name:'fixture-http',version:'1.0.0'},{supportedProtocolVersions:[version],versionNegotiation:{mode:version==='2026-07-28'?{pin:version}:'legacy'}});
    try{
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      await exercise(client);
      assert.ok(metrics.length>=6);
      for(const metric of metrics)assert.deepEqual(Object.keys(metric as object).sort(),['durationMs','status','tool','version']);
    }finally{await client.close();await service.close();}
  });
}

test('local opt-in advertises probe without any startup connection',async()=>{
  const sentinel='MCP_PASSWORD_SENTINEL';
  const client=new Client({name:'fixture-local',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/transports/stdio.js')],stderr:'pipe',env:{PATH:process.env.PATH??'',IPVOLT_ENABLE_ROUTE_CHECK:'1',IPVOLT_PROXY_URL:`http://user:${sentinel}@127.0.0.1:1`}});
  let stderr='';transport.stderr?.on('data',chunk=>stderr+=chunk.toString());
  try{
    await client.connect(transport);
    const list=await client.listTools();assert.equal(list.tools.length,5);
    assert.ok(!JSON.stringify(list).includes(sentinel));
    const result=await client.callTool({name:'check_proxy_route',arguments:{profile:'default'}});
    assert.equal(result.isError,true);
    assert.ok(!JSON.stringify(result).includes(sentinel));assert.equal(stderr,'');
  }finally{await client.close();}
});

test('all reviewed documents round-trip through bounded cursor chunks',async()=>{
  const {loadPublicCatalog}=await import('../src/core/catalog.js');
  const catalog=loadPublicCatalog();
  const source=JSON.parse(await readFile(new URL('../content/catalog.json',import.meta.url),'utf8'));
  for(const doc of source.documents){
    const chunks:string[]=[];let cursor:undefined|string;
    do{
      const part=catalog.get({documentId:doc.id,cursor});
      assert.ok(Buffer.byteLength(JSON.stringify(part))<16_384);
      chunks.push(part.markdown);cursor=part.nextCursor??undefined;
    }while(cursor);
    assert.equal(chunks.join(''),doc.markdown);
  }
});
