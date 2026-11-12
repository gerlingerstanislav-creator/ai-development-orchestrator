// Narrow loopback bridge: Codex QA sandbox cannot reach Docker services directly.
// All remote browser calls are authenticated to one active, short-lived QA job.
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
const sessions=new Map();
const equal=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&x.length>24&&timingSafeEqual(x,y);};
const reply=(res,code,payload)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(payload));};
const upstream=process.env.QA_BROWSER_URL||'http://qa-browser:4301';
export function openQaBrowserSession(id,caseIds=[],{adHoc=false}={}){
 const token=randomBytes(32).toString('hex');
 sessions.set(id,{token,caseIds:new Set(caseIds),adHoc,assertions:[]});
 return {session:id,token};
}
// Trusted evidence captured after Playwright has actually evaluated a JS assertion.
// It is not derived from the QA model's summary or shell-command spelling.
export function getQaBrowserEvidence(id){return (sessions.get(id)?.assertions||[]).map(entry=>({...entry}));}
export async function closeQaBrowserSession(id){
 const session=sessions.get(id);
 if(!session)return;
 sessions.delete(id);
 try{await fetch(upstream+'/action',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({session:id,token:session.token,action:'close'}),signal:AbortSignal.timeout(4000)});}catch{}
}
export async function browserHealth(){
 try{const r=await fetch(upstream+'/health',{signal:AbortSignal.timeout(18000)});
  return r.ok&&(await r.json()).ok===true;
 }catch{return false;}
}
export function startQaBrowserGateway(){
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/action')return reply(res,404,{ok:false,error:'Not found'});
  try{
   let raw='';
   for await(const part of req){raw+=part.toString();if(raw.length>12000)throw Error('Request too large');}
   const body=JSON.parse(raw),session=sessions.get(body.session);
   if(!session||!equal(session.token,body.token))return reply(res,403,{ok:false,error:'Session expired'});
   if(!['start','close','goto','viewport','click','fill','count','text','screenshot','assert'].includes(body.action))
    return reply(res,400,{ok:false,error:'Unsupported browser operation'});
   const kind=String(body.qaKind||''),id=String(body.qaId||'');
   if(kind||id){
    if(body.action!=='assert'||!(kind==='case'?(session.caseIds.has(id)||(session.adHoc&&/^qa-(?:[1-9]|1[0-9]|20)$/.test(id))):kind==='check'&&/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)))
     return reply(res,400,{ok:false,error:'Invalid QA assertion identity'});
   }
   const remote=await fetch(upstream+'/action',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
   const data=await remote.json();
   if(body.action==='assert'&&kind&&['passed','failed'].includes(data.assertion)&&session.assertions.length<200){
    session.assertions.push({kind,id,result:data.assertion,expression:String(body.expression||'').slice(0,1800),
     actual:data.actual??null,viewport:data.viewport??null});
   }
   if(body.action==='close')sessions.delete(body.session);
   return reply(res,remote.status,data);
  }catch(error){return reply(res,503,{ok:false,error:String(error.message||error).slice(0,800)});}
 });
 server.listen(4311,'127.0.0.1');
 return server;
}
