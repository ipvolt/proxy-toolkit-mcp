import type { JSONRPCMessage } from '@modelcontextprotocol/server';

export const PUBLIC_ERRORS=new Set([
  'Unknown reviewed public document. Use search_proxy_docs to find a document ID.',
  'Unknown document section. Use the section titles returned by get_proxy_doc.',
  'Invalid or stale document cursor. Start again without a cursor.',
  'The tool could not complete this request. Check the documented inputs and try again.',
]);
const TOOL_ERROR='Invalid tool request. Use tools/list to check the supported tool name, fields and versions.';
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}

/** SDK input validation happens before our tool callbacks. Never reflect rejected inputs. */
export function sanitizeProtocolMessage(message:JSONRPCMessage):JSONRPCMessage {
  if('error' in message){
    const messages:Record<number,string>={[-32700]:'Parse error',[-32600]:'Invalid request',[-32601]:'Method not found',[-32602]:'Invalid request parameters',[-32603]:'Internal error',[-32022]:'Unsupported protocol version'};
    const data=message.error.data;
    const versions=record(data)&&Array.isArray(data.supported)?data.supported.filter(version=>typeof version==='string'&&['2026-07-28','2025-11-25','2025-06-18','2025-03-26'].includes(version)):[];
    const requested=record(data)&&typeof data.requested==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(data.requested)?data.requested:undefined;
    return {...message,error:{code:message.error.code,message:messages[message.error.code]??'MCP request failed',...(versions.length?{data:{supported:versions,...(requested?{requested}:{})}}:{})}};
  }
  if('result' in message&&record(message.result)&&message.result.isError===true){
    const result=message.result;
    // Our own typed route failures have structured output; SDK validation errors do not.
    if(record(result.structuredContent))return {...message,result:{...result,content:[{type:'text',text:JSON.stringify(result.structuredContent)}]}};
    const content=result.content;
    if(Array.isArray(content)&&content.length===1&&record(content[0])&&content[0].type==='text'&&typeof content[0].text==='string'&&PUBLIC_ERRORS.has(content[0].text))return message;
    return {...message,result:{
      ...(result.resultType==='complete'?{resultType:'complete'}:{}),
      ...(record(result._meta)?{_meta:result._meta}:{}),
      isError:true,content:[{type:'text',text:TOOL_ERROR}],
    }};
  }
  return message;
}

/** Exchanges are bounded and request-scoped; long-lived subscriptions are disabled. */
export async function sanitizeProtocolResponse(response:Response):Promise<Response>{
  if(!response.body)return response;
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];let length=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>131_072)throw new Error('Response is too large');chunks.push(value);}
  }catch{await reader.cancel();return new Response(JSON.stringify({error:'MCP response could not be completed'}),{status:500,headers:{'Content-Type':'application/json'}});}
  const text=Buffer.concat(chunks).toString('utf8');
  let body:string;
  try{
    if(response.headers.get('content-type')?.includes('text/event-stream')){
      body=text.split('\n').map(line=>line.startsWith('data: ')?'data: '+JSON.stringify(sanitizeProtocolMessage(JSON.parse(line.slice(6)))):line).join('\n');
    }else if(response.headers.get('content-type')?.includes('application/json')){
      body=JSON.stringify(sanitizeProtocolMessage(JSON.parse(text)));
    }else{body='MCP request rejected';}
  }catch{body=JSON.stringify({error:'MCP response could not be completed'});}
  const headers=new Headers(response.headers);headers.delete('content-length');
  return new Response(body,{status:response.status,statusText:response.statusText,headers});
}
