import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import {withReaderContext} from './agent-context.mjs';

test('runner opens a scoped reader and uses the real MCP adapter to read a section',async t=>{
 const secret='a'.repeat(64),runnerSecret='runner-test-secret';
 const scope={projectId:'coffee-project',taskId:'unpaid-orders',role:'testing',processId:'qa-run'};
 const tool={name:'knowledge.section',inputSchema:{type:'object'}};
 const requests=[];
 const server=createServer(async(req,res)=>{
  let raw='';
  for await(const chunk of req)raw+=chunk;
  requests.push({method:req.method,url:req.url,runner:req.headers['x-runner-secret'],agent:req.headers['x-agent-token'],body:raw?JSON.parse(raw):null});
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/reader-sessions')&&req.method==='POST')return res.writeHead(201).end(JSON.stringify({secret}));
  if(req.url.endsWith('/reader-sessions')&&req.method==='DELETE')return res.writeHead(204).end();
  if(req.url.endsWith('/catalog'))return res.end(JSON.stringify({tools:[tool]}));
  res.end(JSON.stringify({result:{title:'Неоплаченные заказы',body:'Требование к обработке заказа'}}));
 });
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port+'/internal/agent-tools';
 const replies=await withReaderContext(base,runnerSecret,scope,async context=>{
  assert.ok(context.args.some(value=>value.includes('mcp_servers.orchestrator.command')));
  assert.ok(!context.args.join(' ').includes(secret));
  assert.match(context.prefix,/knowledge\.section/);
  const adapter=fileURLToPath(new URL('./agent-mcp.mjs',import.meta.url));
  const child=spawn(process.execPath,[adapter],{env:context.env,stdio:['pipe','pipe','pipe']});
  let output='',errors='';
  child.stdout.on('data',data=>{output+=data;});
  child.stderr.on('data',data=>{errors+=data;});
  child.stdin.end([
   {jsonrpc:'2.0',id:1,method:'tools/list'},
   {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'knowledge.section',arguments:{document_id:'requirements',section_id:'unpaid'}}}
  ].map(message=>JSON.stringify(message)).join('\n')+'\n');
  const [exitCode]=await once(child,'close');
  assert.equal(exitCode,0,errors);
  return output.trim().split('\n').map(line=>JSON.parse(line));
 });
 assert.deepEqual(replies[0].result.tools,[tool]);
 assert.match(JSON.parse(replies[1].result.content[0].text).body,/заказа/);
 assert.deepEqual(requests[0],{method:'POST',url:'/internal/agent-tools/reader-sessions',runner:runnerSecret,agent:undefined,body:scope});
 assert.equal(requests[1].agent,secret);
 assert.equal(requests[1].runner,undefined);
 assert.equal(requests[2].body.name,'knowledge.section');
 assert.equal(requests.at(-1).method,'DELETE');
 assert.equal(requests.at(-1).agent,secret);
});
