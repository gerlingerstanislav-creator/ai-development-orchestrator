import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {inspectGithubRepository} from './repository-gateway.js';

type ProjectGitDeps={
 app:FastifyInstance;
 pool:Pick<Pool,'query'>;
 uid:(req:any)=>string;
 access:(req:any,reply:any,id:string)=>Promise<boolean>;
 decryptToken:(encrypted:string)=>string;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/** Project GitHub connections: encrypted secret is never returned to browsers. */
export function registerProjectGitRoutes({app,pool,uid,access,decryptToken}:ProjectGitDeps){
 const repositoryNameSchema=z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
app.get('/api/projects/:id/git',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const r=await pool.query('SELECT g.repository,g.default_branch,g.target_branch,g.connection_id,c.name AS connection_name FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.owner_id=$2',[id,uid(req)]);
 return r.rows[0]||null;
});
app.put('/api/projects/:id/git',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const {repository,connectionId,targetBranch}=parse(z.object({repository:repositoryNameSchema,connectionId:z.string().uuid(),targetBranch:z.string().regex(/^[a-zA-Z0-9_./-]{1,150}$/).optional()}),req.body);
 const r=await pool.query('SELECT provider,secret_encrypted FROM connections WHERE id=$1 AND owner_id=$2',[connectionId,uid(req)]);
 if(!r.rowCount || r.rows[0].provider!=='github_token')return reply.code(400).send({error:'Выбери своё подключение типа GitHub token'});
 const token=decryptToken(r.rows[0].secret_encrypted);
 let info;
 try{info=await inspectGithubRepository(token,repository);}
 catch(e){const err=e as Error & {statusCode?:number};return reply.code(err.statusCode||502).send({error:err.message||'Ошибка проверки GitHub'});}
 const branch=targetBranch||info.branch;
 const ghHeaders={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const baseUrl='https://api.github.com/repos/'+info.name;
 let branchCheck=await fetch(baseUrl+'/branches/'+encodeURIComponent(branch),{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
 let initialized=false;
 if(branchCheck.status===404){
  const branchList=await fetch(baseUrl+'/branches?per_page=1',{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
  if(!branchList.ok)return reply.code(502).send({error:'Не удалось проверить ветки GitHub'});
  const branches=await branchList.json() as any[];
  if(branches.length===0){
   // GitHub returns default_branch even for an empty repository. The first commit
   // creates that default branch. Never initialize an existing repository.
   const init=await fetch(baseUrl+'/contents/README.md',{method:'PUT',headers:{...ghHeaders,'Content-Type':'application/json'},
    body:JSON.stringify({message:'Initial commit: initialize repository for AI Development Orchestrator',
      content:Buffer.from('# '+info.name.split('/')[1]+'\n\nПроект подключён к AI Development Orchestrator.\n').toString('base64')}),
    signal:AbortSignal.timeout(20000)});
   if(!init.ok){
    const details=await init.json().catch(()=>({})) as any;
    return reply.code(409).send({error:'Не удалось создать первый коммит: '+String(details.message||init.status).slice(0,250)});
   }
   initialized=true;
   branchCheck=await fetch(baseUrl+'/branches/'+encodeURIComponent(branch),{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
  }
 }
 if(!branchCheck.ok)return reply.code(400).send({error:'Целевая ветка GitHub не найдена. Для пустого репозитория первый коммит создаётся в ветке '+info.branch+'. Укажи её или создай нужную ветку.'});
 const prAccess=await fetch(baseUrl+'/pulls?state=open&per_page=1',{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
 if(prAccess.status===403)return reply.code(409).send({error:'Подключение GitHub не сохранено: токен не имеет доступа к Pull Requests (HTTP 403). На github.com/settings/personal-access-tokens включи Repository permissions → Pull requests → Read and write для '+info.name+' и повтори проверку.'});
 if(!prAccess.ok)return reply.code(502).send({error:'Не удалось проверить права доступа к Pull Requests: GitHub HTTP '+prAccess.status});
 // Checks and commit statuses may not be readable by fine-grained tokens.
 // Do not reject repository binding: GitHub enforces required checks at merge time.

  await pool.query('INSERT INTO project_git_repositories(project_id,connection_id,repository,default_branch,target_branch) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id) DO UPDATE SET connection_id=$2,repository=$3,default_branch=$4,target_branch=$5,updated_at=now()',[id,connectionId,info.name,info.branch,branch]);

 return {repository:info.name,default_branch:info.branch,target_branch:branch,connection_id:connectionId,can_push:info.canPush,private:info.private,initialized};
});
app.delete('/api/projects/:id/git',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 await pool.query('DELETE FROM project_git_repositories WHERE project_id=$1',[id]);
 return {ok:true};
});



}
