// Dedicated QA browser host. It runs outside Codex's seccomp sandbox, but on
// an internal Docker network with no Docker socket, application secrets or egress.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,stat,realpath,mkdir,readdir} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {chromium} from 'playwright';

const workspaceRoot=process.env.QA_WORKSPACES_DIR||'/var/lib/ado-qa-workspaces';
const sessions=new Map();
// A Runner crash can skip its finally block; release orphaned Chromium and
// dev-server processes without ever accepting a mismatched session token.
const SESSION_IDLE_MS=45*60*1000;
const idPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const send=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
async function readBody(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>10000)throw Error('Request too large');}return JSON.parse(data);}
function sameToken(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&x.length>24&&timingSafeEqual(x,y);}
const exists=async p=>!!(await stat(p).catch(()=>null));
async function staticServer(folder){
 const server=http.createServer(async(req,res)=>{
  try{
   const path=new URL(req.url||'/','http://127.0.0.1').pathname;
   const target=resolve(folder,'.'+decodeURIComponent(path));
   if(target!==folder&&!target.startsWith(folder+sep)){res.writeHead(403);res.end();return;}
   let file=target;
   if((await stat(file).catch(()=>null))?.isDirectory())file=join(file,'index.html');
   if(!await exists(file)){
    const fallback=join(folder,'index.html');
    if(!await exists(fallback)){res.writeHead(404);res.end('Not found');return;}
    file=fallback; // SPA client routing only when an index really exists
   }
   const canonical=await realpath(file);
   if(canonical!==folder&&!canonical.startsWith(folder+sep)){res.writeHead(403);res.end();return;}
   const data=await readFile(canonical);
   res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
   res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
 });
 await new Promise((ok,fail)=>server.once('error',fail).listen(0,'127.0.0.1',ok));
 return {server,port:server.address().port};
}
async function portNumber(){
 const server=http.createServer();
 await new Promise((ok,fail)=>server.once('error',fail).listen(0,'127.0.0.1',ok));
 const port=server.address().port;
 await new Promise(resolve=>server.close(resolve));
 return port;
}
async function htmlEntry(folder){
 const pages=(await readdir(folder,{withFileTypes:true})).filter(entry=>entry.isFile()&&/\.html?$/i.test(entry.name))
  .map(entry=>entry.name).sort();
 return {pages,entry:pages.includes('index.html')?'/':pages.length?'/'+encodeURIComponent(pages[0]):'/'};
}
function localPagePath(path){
 const value=String(path||'/');
 if(!value.startsWith('/')||value.startsWith('//')||value.includes('\\')||value.includes('\0'))
  throw Error('Only local application paths are allowed');
 return value;
}
async function application(session){
 const root=session.root;
 const packageFile=join(root,'package.json');
 const pkg=await readFile(packageFile,'utf8').then(JSON.parse).catch(()=>null);
 const dist=['dist','build','apps/web/dist','out'].map(p=>join(root,p));
 let built=null;
 for(const p of dist)if(await exists(join(p,'index.html'))){built=p;break;}
 // Prefer an already built application; standalone HTML projects need no index.html.
 const folder=built||root;
 const {pages,entry}=await htmlEntry(folder);
 if(!built&&pkg?.scripts?.dev&&await exists(join(root,'node_modules'))){
  const port=await portNumber();
  const vite=/\bvite\b/.test(pkg.scripts.dev);
  const argv=['run','dev',...(vite?['--','--host','127.0.0.1','--port',String(port),'--strictPort']:[])];
  const proc=spawn('npm',argv,{cwd:root,stdio:'ignore',env:{PATH:process.env.PATH,HOME:'/tmp',PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'test'},detached:false});
  session.proc=proc;
  for(let i=0;i<60;i++){
   if(proc.exitCode!==null)break;
   try{const r=await fetch('http://127.0.0.1:'+port+entry,{signal:AbortSignal.timeout(750)});if(r.status<500)return {port,entry,pages};}catch{}
   await new Promise(r=>setTimeout(r,250));
  }
  proc.kill('SIGTERM');session.proc=null;
  if(!built)throw Error('Dev server did not start; run npm install and npm run build in QA workspace');
 }
 if(!pages.length)throw Error('No browser-ready HTML entry point found; build the application or provide an HTML page');
 const app=await staticServer(folder);
 session.server=app.server;
 return {port:app.port,entry,pages};
}
async function prepare(id,token){
 if(!idPattern.test(id))throw Error('Invalid QA session');
 const prev=sessions.get(id);
 if(prev){
  if(!sameToken(prev.token,token))throw Error('Invalid QA session token');
  prev.lastActivity=Date.now();
  return prev;
 }
 const root=join(workspaceRoot,'ado-qa-'+id,'repo');
 const canonical=await realpath(root);
 if(canonical!==root||!(await stat(root)).isDirectory())throw Error('QA workspace is unavailable');
 const session={id,token,root,createdAt:Date.now(),lastActivity:Date.now(),page:null,browser:null,server:null,proc:null};
 sessions.set(id,session);
 return session;
}
async function stop(s){
 if(s.stopping)return s.stopping;
 s.stopping=(async()=>{
  try{
   await s.browser?.close().catch(()=>{});
   if(s.proc){s.proc.kill('SIGTERM');s.proc=null;}
   if(s.server)await new Promise(r=>s.server.close(r));
  }finally{sessions.delete(s.id);}
 })();
 return s.stopping;
}
// Keep the browser host self-healing even when its Runner is restarted while
// a session is active. Active sessions refresh their lease on each request.
const staleSessionTimer=setInterval(()=>{
 const now=Date.now();
 for(const s of sessions.values()){
  if(now-s.lastActivity>SESSION_IDLE_MS)
   void stop(s).catch(error=>process.stderr.write('QA session cleanup failed: '+String(error)+'\n'));
 }
},60_000);
staleSessionTimer.unref();
async function run(s,body){
 const action=body.action;
 if(action==='close'){await stop(s);return {ok:true};}
 if(action==='start'){
  if(s.page)return {ok:true,message:'Browser already started',path:s.path};
  try{
   const {port,entry,pages}=await application(s);
   const path=localPagePath(body.path||entry);
   s.origin='http://127.0.0.1:'+port;
   // Verify the application HTTP endpoint before starting Chromium, so a
   // Vite/static-server failure is distinguishable from a browser failure.
   const response=await fetch(s.origin+path,{signal:AbortSignal.timeout(7000)});
   if(!response.ok)throw Error('Local application HTTP '+response.status+' at '+path);
   s.browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server']});
   s.context=await s.browser.newContext({viewport:{width:1280,height:800}});
   s.page=await s.context.newPage();
   // DOMContentLoaded may be indefinitely delayed by third-party scripts
   // (Chromium is deliberately offline). A committed local navigation is
   // sufficient to begin real DOM assertions; never fake their result.
   const navigation=await s.page.goto(s.origin+path,{waitUntil:'commit',timeout:12000});
   // Give local DOM time to settle without blocking on offline CDN scripts.
   await s.page.waitForLoadState('domcontentloaded',{timeout:4000}).catch(()=>{});
   if(navigation&&!navigation.ok())throw Error('Chromium HTTP '+navigation.status()+' at '+path);
   s.path=path;
   return {ok:true,origin:'local QA application',path,availablePages:pages,
    readyState:await s.page.evaluate(()=>document.readyState),
    title:await s.page.title(),browser:'Chromium / Playwright'};
  }catch(error){
   await stop(s);
   throw Error('QA browser start failed: '+String(error.message||error));
  }
 }
 if(!s.page)throw Error('Start QA browser first: browser-client.mjs start');
 const page=s.page;
 const selector=String(body.selector||'').slice(0,500);
 const timeout=7000;
 if(action==='goto'){
  const path=localPagePath(body.path||'/');
  const navigation=await page.goto(s.origin+path,{waitUntil:'commit',timeout:12000});
  await page.waitForLoadState('domcontentloaded',{timeout:4000}).catch(()=>{});
  if(navigation&&!navigation.ok())throw Error('Chromium HTTP '+navigation.status()+' at '+path);
  s.path=path;
  return {ok:true,title:await page.title(),path,readyState:await page.evaluate(()=>document.readyState)};
 }
 if(action==='viewport'){
  const width=Number(body.width),height=Number(body.height);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<240||width>2560||height<240||height>2560)throw Error('Invalid viewport');
  await page.setViewportSize({width,height});
  return {ok:true,width,height};
 }
 if(action==='click'){await page.locator(selector).first().click({timeout});return {ok:true,clicked:selector};}
 if(action==='fill'){await page.locator(selector).first().fill(String(body.value||'').slice(0,2000),{timeout});return {ok:true,filled:selector};}
 if(action==='count')return {ok:true,selector,count:await page.locator(selector).count()};
 if(action==='text')return {ok:true,selector,text:(await page.locator(selector).first().innerText({timeout})).slice(0,3000)};
 if(action==='screenshot'){
  const evidence=join(s.root,'.ado-qa-evidence');
  await mkdir(evidence,{recursive:true,mode:0o700});
  const filename=randomUUID()+'.jpg';
  await page.screenshot({path:join(evidence,filename),type:'jpeg',quality:68,fullPage:false,timeout:20000});
  return {ok:true,screenshot:'.ado-qa-evidence/'+filename,viewport:page.viewportSize()};
 }
 if(action==='assert'){
  const expression=String(body.expression||'').trim();
  if(!expression||expression.length>3000)throw Error('Invalid browser assertion');
  const value=await page.evaluate(expression);
  if(value!==true)return {ok:false,assertion:'failed',actual:value===undefined?'undefined':JSON.stringify(value).slice(0,1000),viewport:page.viewportSize()};
  return {ok:true,assertion:'passed',expression:expression.slice(0,300),viewport:page.viewportSize()};
 }
 throw Error('Unsupported QA browser action');
}
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/health'){
   // Exercise Chromium; an installed binary without a launchable browser is not healthy.
   const b=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server'],timeout:12000});
   await b.close();return send(res,200,{ok:true,browser:'chromium'});
  }
  if(req.method!=='POST'||req.url!=='/action'||req.headers['content-type']!=='application/json')return send(res,404,{error:'Not found'});
  const body=await readBody(req);
  const s=await prepare(String(body.session||''),String(body.token||''));
  try{return send(res,200,await run(s,body));}
  catch(error){return send(res,422,{ok:false,error:String(error.message||error).slice(0,1500)});}
 }catch(error){return send(res,400,{ok:false,error:String(error.message||error).slice(0,1000)});}
});
server.listen(4301,'0.0.0.0');
process.on('SIGTERM',()=>{clearInterval(staleSessionTimer);for(const s of sessions.values())void stop(s);server.close();});
