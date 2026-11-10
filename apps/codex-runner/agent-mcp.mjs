// Self-contained MCP STDIO adapter for Codex CLI. One JSON-RPC message per line;
// never print debug text or credentials to stdout.
import {createInterface} from 'node:readline';
const base=process.env.ADO_AGENT_API_URL||'http://api:3001/internal/agent-tools';
const token=process.env.ADO_AGENT_SESSION_TOKEN||'';
if(!/^[0-9a-f]{64}$/.test(token))throw Error('Missing scoped agent session');
let tools=null;
async function request(path,method='GET',body=null){
 const response=await fetch(base+path,{
  method,headers:{'X-Agent-Token':token,'Content-Type':'application/json'},
  body:body===null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(String(data.error||'Agent API '+response.status).slice(0,900));
 return data;
}
async function handle(message){
 const {id,method}=message;
 if(id===undefined||id===null)return;
 if(method==='initialize')
  return {protocolVersion:message.params?.protocolVersion||'2025-03-26',
   capabilities:{tools:{listChanged:false}},serverInfo:{name:'ai-development-orchestrator',version:'1.0.0'}};
 if(method==='ping')return {};
 if(method==='tools/list'){
  if(!tools)tools=(await request('/catalog')).tools;
  return {tools};
 }
 if(method==='tools/call'){
  const name=message.params?.name;
  if(typeof name!=='string')throw Error('Missing tool name');
  try{
   const data=await request('/call','POST',{name,arguments:message.params?.arguments||{}});
   return {content:[{type:'text',text:JSON.stringify(data.result)}],isError:false};
  }catch(error){
   return {content:[{type:'text',text:String(error?.message||error).slice(0,900)}],isError:true};
  }
 }
 throw Object.assign(Error('Unknown MCP method '+method),{code:-32601});
}
const send=payload=>process.stdout.write(JSON.stringify(payload)+'\n');
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines){
 if(!line.trim())continue;
 let msg=null;
 try{msg=JSON.parse(line);}catch{continue;}
 if(msg.id===undefined||msg.id===null)continue;
 try{const result=await handle(msg);send({jsonrpc:'2.0',id:msg.id,result});}
 catch(error){send({jsonrpc:'2.0',id:msg.id,error:{code:error?.code||-32603,message:String(error?.message||error).slice(0,900)}});}
}
