import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {approvedCodexConnectHost,startCodexProxy} from './codex-proxy.mjs';

test('CONNECT ACL only permits expected OpenAI hosts on 443',()=>{
 for(const host of ['auth.openai.com:443','api.openai.com:443','chatgpt.com:443','sub.chatgpt.com:443'])
  assert.ok(approvedCodexConnectHost(host));
 for(const host of ['example.com:443','auth.openai.com.evil.org:443','auth.openai.com:80','localhost:443',
  '127.0.0.1:443','chatgpt.com:8443','CHATGPT.COM:443','auth.openai.com:443/foo','[::1]:443'])
  assert.equal(approvedCodexConnectHost(host),null,host);
});

function connectStatus(port,target){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,method:'CONNECT',path:target,timeout:1000});
  req.on('connect',(res,socket)=>{socket.destroy();resolve(res.statusCode)});
  req.on('response',res=>{res.resume();resolve(res.statusCode)});
  req.on('timeout',()=>req.destroy(new Error('proxy did not answer')));
  req.on('error',reject);
  req.end();
 });
}

test('loopback proxy denies forbidden CONNECT without network access',async()=>{
 const proxy=startCodexProxy(0);
 try{
  if(!proxy.server.listening)await once(proxy.server,'listening');
  const port=proxy.server.address().port;
  assert.equal(await connectStatus(port,'example.com:443'),403);
  assert.equal(proxy.stats().attempts,1);
  assert.equal(proxy.stats().successes,0);
  proxy.reset();
  assert.deepEqual(proxy.stats(),{attempts:0,successes:0,lastError:''});
 }finally{
  proxy.server.closeAllConnections();
  await new Promise(resolve=>proxy.server.close(resolve));
 }
});
