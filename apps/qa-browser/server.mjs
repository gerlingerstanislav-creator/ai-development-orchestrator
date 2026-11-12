// Dedicated QA browser host. It runs outside Codex's seccomp sandbox, but on
// an internal Docker network with no Docker socket, application secrets or egress.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,stat,realpath,mkdir} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {chromium} from 'playwright';

const workspaceRoot=process.env.QA_WORKSPACES_DIR||'/var/lib/ado-qa-workspaces';
const sessions=new Map();
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
   if(!await exists(file))file=join(folder,'index.html'); // SPA client routing
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
async function application(session){
 const root=session.root;
 const packageFile=join(root,'package.json');
 const pkg=await readFile(packageFile,'utf8').then(JSON.parse).catch(()=>null);
 const dist=['dist','build','apps/web/dist','out'].map(p=>join(root,p));
 let built=null;
 for(const p of dist)if(await exists(join(p,'index.html'))){built=p;break;}
 if(pkg?.scripts?.dev&&await exists(join(root,'node_modules'))){
  const port=await portNumber();
  const vite=/\bvite\b/.test(pkg.scripts.dev);
  const argv=['run','dev',...(vite?['--','--host','127.0.0.1','--port',String(port),'--strictPort']:[])];
  const proc=spawn('npm',argv,{cwd:root,stdio:'ignore',env:{PATH:process.env.PATH,HOME:'/tmp',PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'test'},detached:false});
  session.proc=proc;
  for(let i=0;i<60;i++){
   if(proc.exitCode!==null)break;
   try{const r=await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(750)});if(r.status<500)return port;}catch{}
   await new Promise(r=>setTimeout(r,250));
  }
  proc.kill('SIGTERM');session.proc=null;
  if(!built)throw Error('Dev server did not start; run npm install and npm run build in QA workspace');
 }
 const folder=built||(await exists(join(root,'index.html'))?root:null);
 if(!folder)throw Error('No browser-ready index.html found; build the application first');
 const app=await staticServer(folder);
 session.server=app.server;
 return app.port;
}
async function prepare(id,token){
 if(!idPattern.test(id))throw Error('Invalid QA session');
 const prev=sessions.get(id);
 if(prev){if(!sameToken(prev.token,token))throw Error('Invalid QA session token');return prev;}
 const root=join(workspaceRoot,'ado-qa-'+id,'repo');
 const canonical=await realpath(root);
 if(canonical!==root||!(await stat(root)).isDirectory())throw Error('QA workspace is unavailable');
 const session={id,token,root,createdAt:Date.now(),page:null,browser:null,server:null,proc:null};
 sessions.set(id,session);
 return session;
}
async function stop(s){
 await s.browser?.close().catch(()=>{});
 if(s.proc){s.proc.kill('SIGTERM');s.proc=null;}
 if(s.server)await new Promise(r=>s.server.close(r));
 sessions.delete(s.id);
}
async function run(s,body){
 const action=body.action;
 if(action==='close'){await stop(s);return {ok:true};}
 if(action==='start'){
  if(s.page)return {ok:true,message:'Browser already started'};
  const port=await application(s);
  s.browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  s.context=await s.browser.newContext({viewport:{width:1280,height:800}});
  s.page=await s.context.newPage();
  s.origin='http://127.0.0.1:'+port;
  await s.page.goto(s.origin+'/',{waitUntil:'domcontentloaded',timeout:20000});
  return {ok:true,origin:'local QA application',title:await s.page.title(),browser:'Chromium / Playwright'};
 }
 if(!s.page)throw Error('Start QA browser first: browser-client.mjs start');
 const page=s.page;
 const selector=String(body.selector||'').slice(0,500);
 const timeout=7000;
 if(action==='goto'){
  const path=String(body.path||'/');
  if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))throw Error('Only local application paths are allowed');
  await page.goto(s.origin+path,{waitUntil:'domcontentloaded',timeout:20000});
  return {ok:true,title:await page.title(),path};
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
  if(value!==true)return {ok:false,assertion:'failed',actual:value===undefined?'undefined':JSON.stringify(value).slice(0,1000)};
  return {ok:true,assertion:'passed',expression:expression.slice(0,300)};
 }
 throw Error('Unsupported QA browser action');
}
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/health'){
   // Exercise Chromium; an installed binary without a launchable browser is not healthy.
   const b=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],timeout:12000});
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
process.on('SIGTERM',()=>{for(const s of sessions.values())void stop(s);server.close();});
