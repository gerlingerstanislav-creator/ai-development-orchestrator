import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

test('Codex MCP stdio adapter discovers and executes scoped backend tools',async t=>{
 const secret='a'.repeat(64),calls=[];
 const api=createServer(async(req,res)=>{
  assert.equal(req.headers['x-agent-token'],secret);
  let result;
  if(req.url==='/internal/agent-tools/catalog')result={tools:[
   {name:'documents.list',description:'Read project pages',inputSchema:{type:'object',properties:{}}}
  ]};
  else if(req.url==='/internal/agent-tools/call'){
   let body='';
   for await(const chunk of req)body+=chunk;
   const parsed=JSON.parse(body);
   calls.push(parsed);
   result={result:{documents:[{id:'page-id',title:'ТЗ'}]}};
  }else{res.writeHead(404);res.end('{}');return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 });
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const address=api.address();
 const adapter=fileURLToPath(new URL('../../codex-runner/agent-mcp.mjs',import.meta.url));
 const child=spawn(process.execPath,[adapter],{
  env:{...process.env,ADO_AGENT_SESSION_TOKEN:secret,
   ADO_AGENT_API_URL:'http://127.0.0.1:'+address.port+'/internal/agent-tools'},
  stdio:['pipe','pipe','pipe']
 });
 t.after(async()=>{child.kill();await new Promise(resolve=>api.close(resolve));});
 const pending=new Map();
 let stderr='';
 child.stderr.on('data',data=>stderr+=String(data));
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{
  const data=JSON.parse(line);
  const resolver=pending.get(data.id);
  if(resolver){pending.delete(data.id);resolver(data);}
 });
 const invoke=(id,method,params={})=>new Promise((resolve,reject)=>{
  pending.set(id,resolve);
  const deadline=setTimeout(()=>{pending.delete(id);reject(Error('MCP timeout '+method+': '+stderr.slice(0,200)));},5000);
  pending.set(id,data=>{clearTimeout(deadline);resolve(data);});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 const init=await invoke(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'codex',version:'1.0'}});
 assert.equal(init.result.serverInfo.name,'ai-development-orchestrator');
 const list=await invoke(2,'tools/list');
 assert.equal(list.result.tools[0].name,'documents.list');
 const called=await invoke(3,'tools/call',{name:'documents.list',arguments:{}});
 assert.equal(called.result.isError,false);
 assert.equal(JSON.parse(called.result.content[0].text).documents[0].title,'ТЗ');
 assert.deepEqual(calls,[{name:'documents.list',arguments:{}}]);
 assert.ok(!JSON.stringify([init,list,called]).includes(secret),'Session credential stays out of MCP responses');
});
