import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';

type CodexApiDeps={
 app:FastifyInstance;
 pool:Pick<Pool,'query'>;
 runnerUrl:string;
 runnerSecret:()=>string;
 adminEmail:()=>string;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
};

/**
 * Administrator-only Codex subscription controls.
 * Keep the routes (and upstream timeout/error conventions) unchanged.
 * Secrets are read lazily: registration precedes the runner secret setup.
 */
export function registerCodexAdminRoutes({
 app,pool,runnerUrl,runnerSecret,adminEmail,requireAdmin
}:CodexApiDeps){
// Codex uses a personal ChatGPT entitlement. Keep access restricted to the bootstrap administrator.
app.addHook('preHandler',async(req,reply)=>{
 if(!req.url.startsWith('/api/codex/'))return;
 const email=(await pool.query('SELECT email FROM users WHERE id=$1',[(req as any).userId])).rows[0]?.email;
 if(!email || email!==adminEmail())return reply.code(403).send({error:'Только администратор может подключать Codex'});
});
// Local-only Codex runner. The service is not exposed on a host port.
// Requests reach it only after the ordinary application session check.
async function codexCall(path:string,method:'GET'|'POST'='GET') {
 const response=await fetch(runnerUrl+path,{method,headers:{'X-Runner-Secret':runnerSecret()},signal:AbortSignal.timeout(path==='/test'?125000:15000)});
 const body=await response.json().catch(()=>({error:'Некорректный ответ Codex'}));
 if(!response.ok)throw Error(body.error||'Codex недоступен');
 return body;
}
app.get('/api/codex/rate-limits',async(req:any,reply)=>{
 if(!await requireAdmin(req,reply))return;
 const started=Date.now();
 const force=req.query?.refresh==='1';
 try{
  const response=await fetch(runnerUrl+'/usage-limits'+(force?'?refresh=1':''),{
   headers:{'X-Runner-Secret':runnerSecret()},signal:AbortSignal.timeout(25000)
  });
  const body=await response.json().catch(()=>({error:'Codex Runner вернул некорректный JSON'})) as any;
  if(!response.ok){
   const message=String(body.error||'Codex Runner не предоставил лимиты').slice(0,260);
   req.log.warn({status:response.status,duration_ms:Date.now()-started},'Codex rate limits upstream unavailable');
   return reply.code(response.status===409?409:503).send({error:message});
  }
  if(!Array.isArray(body.windows)){
   req.log.warn({duration_ms:Date.now()-started},'Codex rate limits response has no windows array');
   return reply.code(503).send({error:'Codex Runner вернул неожиданный формат лимитов'});
  }
  return body;
 }catch(e){
  const cause=(e as {cause?:{code?:string}})?.cause;
  const reason=e instanceof Error?e.message:'Не удалось получить лимиты Codex';
  const suffix=cause?.code?' ('+cause.code+')':'';
  req.log.warn({error:reason,causeCode:cause?.code||null,duration_ms:Date.now()-started},'Codex rate limits request failed');
  return reply.code(503).send({error:'Нет соединения с Codex Runner: '+reason.slice(0,160)+suffix});
 }
});
app.get('/api/codex/status',async(_req,reply)=>{
 try{return await codexCall('/status');}
 catch(e){return reply.code(503).send({connected:false,error:e instanceof Error?e.message:'Контейнер Codex не отвечает'});}
});
app.post('/api/codex/login',async(_req,reply)=>{
 try{return await codexCall('/login','POST');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Ошибка входа в Codex'});}
});
app.get('/api/codex/device',async(_req,reply)=>{
 try{return await codexCall('/device');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Codex недоступен'});}
});
app.post('/api/codex/logout',async(_req,reply)=>{
 try{return await codexCall('/logout','POST');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Ошибка отключения Codex'});}
});
app.post('/api/codex/test',async(_req,reply)=>{
 try{return await codexCall('/test','POST');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Тест Codex не прошёл'});}
});


}
