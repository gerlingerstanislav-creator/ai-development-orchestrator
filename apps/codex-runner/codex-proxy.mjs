import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

/** Exact original CONNECT allow-list; never proxy arbitrary hosts or ports. */
export function approvedCodexConnectHost(target){
 const match=/^([a-z0-9.-]+):(443)$/.exec(target);
 const host=match?.[1]||'';
 const allowed=host==='auth.openai.com'||host==='api.openai.com'||host==='chatgpt.com'||host.endsWith('.openai.com')||host.endsWith('.chatgpt.com');
 return allowed?host:null;
}

export function startCodexProxy(port=4399){
let proxyAttempts=0,proxySuccess=0,proxyLastError='';
const proxyServer=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
proxyServer.on('connect',(req,client,head)=>{
 proxyAttempts++;
 const host=approvedCodexConnectHost(req.url||'');
 if(!host){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
 const remote=net.connect({host,port:443,family:4,timeout:12000});
 let established=false;
 remote.once('connect',()=>{proxySuccess++;established=true;client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head?.length)remote.write(head);remote.pipe(client);client.pipe(remote);});
 remote.on('error',(e)=>{proxyLastError=e.code||e.message||'connection_error';if(!established)client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');else client.destroy();});
 remote.on('timeout',()=>{proxyLastError='timeout';remote.destroy();});
 client.on('error',()=>remote.destroy());
 client.on('close',()=>remote.destroy());
});
proxyServer.listen(port,'127.0.0.1');

 return {
  server:proxyServer,
  url:'http://127.0.0.1:'+port,
  reset(){proxyAttempts=0;proxySuccess=0;proxyLastError='';},
  stats(){return {attempts:proxyAttempts,successes:proxySuccess,lastError:proxyLastError};},
  probe(){return probeProxyEndpoint(port);}
 };
}

export async function probeProxyEndpoint(port=4399){
 // Replicate the HTTP CONNECT + verified TLS path used by Codex.
 // Never report response bodies or OAuth credentials.
 return await new Promise(resolve=>{
  let done=false;
  const finish=message=>{if(done)return;done=true;resolve(message);};
  const req=http.request({host:'127.0.0.1',port,method:'CONNECT',path:'auth.openai.com:443',timeout:12000});
  req.on('connect',(response,socket)=>{
   if(response.statusCode!==200){socket.destroy();finish('Прокси: CONNECT HTTP '+response.statusCode);return;}
   const secure=tls.connect({socket,servername:'auth.openai.com',rejectUnauthorized:true});
   secure.setTimeout(12000);
   secure.once('secureConnect',()=>{
    secure.write('POST /api/accounts/deviceauth/usercode HTTP/1.1\r\nHost: auth.openai.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
   });
   let responseText='';
   secure.on('data',chunk=>{
    responseText+=(chunk.toString('utf8')).slice(0,256);
    const match=responseText.match(/^HTTP\/1\.[01] (\d{3})/);
    if(match){secure.destroy();finish('Прокси + TLS: HTTP '+match[1]);}
   });
   secure.on('end',()=>{if(!done)finish('Прокси + TLS: нет HTTP-ответа');});
   secure.on('error',e=>finish('Прокси + TLS: '+String(e.code||e.message).slice(0,90)));
   secure.on('timeout',()=>{secure.destroy();finish('Прокси + TLS: таймаут');});
  });
  req.on('error',e=>finish('Прокси CONNECT: '+String(e.code||e.message).slice(0,90)));
  req.on('timeout',()=>{req.destroy();finish('Прокси CONNECT: таймаут');});
  req.end();
 });
}

export async function probeAuthEndpoint(){
 try{
  const response=await fetch('https://auth.openai.com/api/accounts/deviceauth/usercode',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(12000)});
  return 'Node.js HTTPS: HTTP '+response.status;
 }catch(error){const cause=error?.cause;return 'Node.js HTTPS: '+String(cause?.code||cause?.message||error.message).slice(0,100);}
}


