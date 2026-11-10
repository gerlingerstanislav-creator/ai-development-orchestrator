import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';

const uuid=z.string().uuid();
const sha=z.string().regex(/^[a-f0-9]{40}$/);
type Db=Pick<Pool,'query'>;
type Deps={pool:Pool;uid:(r:any)=>string;access:(r:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(r:any,reply:any)=>Promise<boolean>;decrypt:(secret:string)=>string;start:(runId:string)=>Promise<void>};
function problem(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode});}
export function validateHealthUrl(value:string){
 let u:URL;
 try{u=new URL(value);}catch{throw problem(400,'Некорректный URL проверки');}
 if(u.protocol!=='https:'||!!u.username||!!u.password||(u.port!==''&&u.port!=='443')||isIP(u.hostname)!==0||
  /(^localhost$|\.localhost$|\.local$|\.internal$)/i.test(u.hostname))
  throw problem(400,'Проверка доступности требует публичный HTTPS hostname');
 return u.toString();
}
export async function initAutomaticDeployment(db:Db){
 await db.query(`
  ALTER TABLE project_deployment_settings DROP CONSTRAINT IF EXISTS project_deployment_settings_mode_check;
  ALTER TABLE project_deployment_settings ADD CONSTRAINT project_deployment_settings_mode_check CHECK(mode IN ('skip','manual','automatic'));
  ALTER TABLE project_deployment_settings ADD COLUMN IF NOT EXISTS health_url text NOT NULL DEFAULT '';
  ALTER TABLE project_deployment_settings ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production';
  ALTER TABLE task_deployment_records DROP CONSTRAINT IF EXISTS task_deployment_records_status_check;
  ALTER TABLE task_deployment_records ADD CONSTRAINT task_deployment_records_status_check CHECK(status IN ('skipped','pending','manual_confirmed','automatic_verified'));
  CREATE TABLE IF NOT EXISTS deployment_runs(
   id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
   sha text NOT NULL,status text NOT NULL DEFAULT 'queued',github_run_id bigint,github_url text,
   message text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),
   updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_active_project ON deployment_runs(project_id) WHERE status IN ('queued','running');
  CREATE INDEX IF NOT EXISTS idx_deployment_runs_task ON deployment_runs(task_id,created_at DESC);
 `);
}
const workflowFile='ado-deploy.yml';
const gitHeaders=(token:string)=>({Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator','Content-Type':'application/json'});
async function git<T=any>(repo:string,token:string,path:string,method='GET',body?:unknown):Promise<T>{
 if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo))throw problem(400,'Некорректный GitHub репозиторий');
 const response=await fetch('https://api.github.com/repos/'+repo+path,{method,headers:gitHeaders(token),
  body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw problem(502,'GitHub '+method+' '+path.split('?')[0]+' HTTP '+response.status);
 return response.status===204?{} as T:await response.json() as T;
}
async function githubConnection(db:Db,projectId:string,userId:string|null){
 const row=(await db.query(`SELECT g.repository,g.default_branch,c.secret_encrypted
  FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id AND c.provider='github_token'
  WHERE g.project_id=$1 AND ($2::uuid IS NULL OR c.owner_id=$2)`,[projectId,userId])).rows[0];
 if(!row)throw problem(409,'Подключи GitHub репозиторий и разреши Actions');
 return row as {repository:string;default_branch:string;secret_encrypted:string};
}
export function deploymentWorkflowTemplate(){
 return [
 'name: ADO verified deployment',
 'run-name: ado-deploy-${{ inputs.request_id }}-${{ inputs.sha }}',
 'on:',
 '  workflow_dispatch:',
 '    inputs:',
 '      sha:',
 '        required: true',
 '        type: string',
 '      request_id:',
 '        required: true',
 '        type: string',
 '      environment:',
 '        required: true',
 '        type: string',
 'permissions:',
 '  contents: read',
 'concurrency:',
 '  group: ado-deploy-${{ inputs.environment }}',
 '  cancel-in-progress: false',
 'jobs:',
 '  deploy:',
 '    environment: ${{ inputs.environment }}',
 '    runs-on: ubuntu-latest',
 '    timeout-minutes: 25',
 '    steps:',
 '      - uses: actions/checkout@v4',
 '        with:',
 '          ref: ${{ inputs.sha }}',
 '          persist-credentials: false',
 '      - name: Verify immutable commit',
 '        env:',
 '          SHA: ${{ inputs.sha }}',
 '        run: |',
 '          [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]',
 '          test "$(git rev-parse HEAD)" = "$SHA"',
 '      - name: Deploy exact commit over SSH',
 '        shell: bash',
 '        env:',
 '          SHA: ${{ inputs.sha }}',
 '          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}',
 '          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}',
 '          DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}',
 '          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}',
 '          DEPLOY_HOST_KEY: ${{ secrets.DEPLOY_HOST_KEY }}',
 '        run: |',
 '          set -euo pipefail',
 '          [[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9.-]+$ ]]',
 '          [[ "$DEPLOY_USER" =~ ^[A-Za-z0-9_-]+$ ]]',
 '          [[ "$DEPLOY_PATH" =~ ^/[A-Za-z0-9_./-]+$ ]]',
 '          [[ -n "$DEPLOY_SSH_KEY" && -n "$DEPLOY_HOST_KEY" ]]',
 '          mkdir -p ~/.ssh && chmod 700 ~/.ssh',
 '          printf "%s\\n" "$DEPLOY_SSH_KEY" > ~/.ssh/id_ed25519',
 '          printf "%s\\n" "$DEPLOY_HOST_KEY" > ~/.ssh/known_hosts',
 '          chmod 600 ~/.ssh/id_ed25519 ~/.ssh/known_hosts',
 '          ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$DEPLOY_USER@$DEPLOY_HOST" "set -e; cd $DEPLOY_PATH; git fetch origin $SHA; git checkout --detach $SHA; docker compose up -d --build"',
 ''
 ].join('\n');
}
export async function prepareWorkflowPr(db:Db,projectId:string,userId:string,decrypt:(v:string)=>string){
 const c=await githubConnection(db,projectId,userId),token=decrypt(c.secret_encrypted),repo=c.repository;
 const path='/.github/workflows/'+workflowFile;
 const existing=await fetch('https://api.github.com/repos/'+repo+'/contents'+path+'?ref='+encodeURIComponent(c.default_branch),
  {headers:gitHeaders(token),signal:AbortSignal.timeout(20000)});
 if(existing.ok)throw problem(409,'Workflow уже находится в основной ветке');
 if(existing.status!==404)throw problem(502,'Не удалось проверить наличие GitHub Actions workflow');
 const branch='ado/devops-deployment-workflow';
 const prs=await git<any[]>(repo,token,'/pulls?state=open&head='+encodeURIComponent(repo.split('/')[0]+':'+branch));
 if(prs.length)return {pr_url:prs[0].html_url,pr_number:prs[0].number,reused:true};
 const base=await git<{commit:{sha:string}}>(repo,token,'/branches/'+encodeURIComponent(c.default_branch));
 await git(repo,token,'/git/refs','POST',{ref:'refs/heads/'+branch,sha:base.commit.sha});
 await git(repo,token,'/contents'+path,'PUT',{message:'ci: configure SHA-based verified deployment',content:Buffer.from(deploymentWorkflowTemplate()).toString('base64'),branch});
 const pr=await git<{number:number;html_url:string}>(repo,token,'/pulls','POST',{
  title:'ci: configure verified SHA-based deployment',head:branch,base:c.default_branch,
  body:'Настройте защищённое окружение GitHub и секреты DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH, DEPLOY_SSH_KEY, DEPLOY_HOST_KEY. Workflow не запускается по push; конкретный SHA отправляет Temporal.'
 });
 return {pr_url:pr.html_url,pr_number:pr.number,reused:false};
}
async function event(db:Db,projectId:string,runId:string,stage:string,detail:string){
 await db.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'deployment',$4,$5)",
  [randomUUID(),projectId,runId,stage,detail.slice(0,1300)]);
}
export function registerAutomaticDeploymentRoutes(app:FastifyInstance,deps:Deps){
 const {pool,uid,access,requireAdmin,decrypt,start}=deps;
 const base='/api/projects/:id';
 const permission=async(req:any,reply:any,id:string)=>await access(req,reply,id)&&await requireAdmin(req,reply);
 app.get(base+'/deployment/runs',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  return (await pool.query('SELECT id,task_id,sha,status,github_url,message,created_at,updated_at,completed_at FROM deployment_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50',[id])).rows;
 });
 app.post(base+'/deployment/prepare-workflow',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await permission(req,reply,id))return;
  return prepareWorkflowPr(pool,id,uid(req),decrypt);
 });
 app.post(base+'/tasks/:taskId/deployment/start',async(req:any,reply)=>{
  const {id,taskId}=z.object({id:uuid,taskId:uuid}).parse(req.params);
  if(!await permission(req,reply,id))return;
  const {commit_sha}=z.object({confirm:z.literal(true),commit_sha:sha}).parse(req.body);
  const client=await pool.connect();let runId='';
  try{
   await client.query('BEGIN');
   const state=(await client.query(`SELECT t.stage,d.status,d.merge_sha,s.mode,s.health_url
    FROM tasks t JOIN task_deployment_records d ON d.task_id=t.id AND d.project_id=t.project_id
    JOIN project_deployment_settings s ON s.project_id=t.project_id
    WHERE t.project_id=$1 AND t.id=$2 FOR UPDATE OF t,d`,[id,taskId])).rows[0];
   if(!state||state.stage!=='deployment'||state.status!=='pending'||state.mode!=='automatic'||state.merge_sha!==commit_sha)
    throw problem(409,'Выкладка требует ожидающего этапа, automatic и точного SHA слитого PR');
   if(!state.health_url)throw problem(409,'Не настроен URL проверки доступности приложения');
   validateHealthUrl(state.health_url);
   await githubConnection(client,id,uid(req));
   runId=randomUUID();
   await client.query('INSERT INTO deployment_runs(id,project_id,task_id,actor_id,sha) VALUES($1,$2,$3,$4,$5)',[runId,id,taskId,uid(req),commit_sha]);
   await event(client,id,runId,'queued','SHA '+commit_sha+' ожидает Temporal');
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await start(runId).catch(e=>req.log.error({error:e,runId},'Temporal deployment dispatch requires recovery'));
  return reply.code(202).send({run_id:runId,status:'queued'});
 });
}
export async function performAutomaticDeployment(pool:Pool,runId:string,decrypt:(v:string)=>string){
 const row=(await pool.query(`SELECT r.*,s.health_url,s.environment,g.repository,g.default_branch,c.secret_encrypted
  FROM deployment_runs r JOIN project_deployment_settings s ON s.project_id=r.project_id
  JOIN project_git_repositories g ON g.project_id=r.project_id JOIN connections c ON c.id=g.connection_id AND c.provider='github_token'
  WHERE r.id=$1`,[runId])).rows[0];
 if(!row||['completed','failed'].includes(row.status))return;
 validateHealthUrl(row.health_url);
 const commit=sha.parse(row.sha),token=decrypt(row.secret_encrypted),repo=row.repository;
 await pool.query("UPDATE deployment_runs SET status='running',message='Проверка GitHub SHA',updated_at=now() WHERE id=$1",[runId]);
 await event(pool,row.project_id,runId,'running','GitHub SHA '+commit);
 const branch=await git<{commit:{sha:string}}>(repo,token,'/branches/'+encodeURIComponent(row.default_branch));
 const comparison=await git<{status:string}>(repo,token,'/compare/'+commit+'...'+branch.commit.sha);
 if(!['ahead','identical'].includes(comparison.status))throw problem(409,'SHA не является предком текущей основной ветки');
 let githubRunId=row.github_run_id as number|null;
 const path='/actions/workflows/'+workflowFile;
 if(!githubRunId){
  await git(repo,token,path+'/dispatches','POST',{ref:row.default_branch,inputs:{sha:commit,request_id:runId,environment:row.environment}});
  await event(pool,row.project_id,runId,'dispatched','Отправлен запрос GitHub workflow_dispatch');
  for(let attempt=0;attempt<40&&!githubRunId;attempt++){
   const list=await git<{workflow_runs:Array<{id:number;display_title:string;html_url:string}>}>(repo,token,path+'/runs?event=workflow_dispatch&per_page=50');
   const match=list.workflow_runs.find(item=>item.display_title==='ado-deploy-'+runId+'-'+commit);
   if(match){
    githubRunId=match.id;
    await pool.query("UPDATE deployment_runs SET github_run_id=$2,github_url=$3,message='GitHub Actions выполняется',updated_at=now() WHERE id=$1",
     [runId,match.id,match.html_url]);
   }else await new Promise(resolve=>setTimeout(resolve,8000));
  }
 }
 if(!githubRunId)throw problem(502,'GitHub не вернул запуск с нужным request_id');
 let success=false;
 for(let attempt=0;attempt<120;attempt++){
  const run=await git<{status:string;conclusion:string|null}>(repo,token,'/actions/runs/'+githubRunId);
  if(run.status==='completed'){success=run.conclusion==='success';break;}
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
 if(!success)throw problem(502,'GitHub Actions завершился неуспешно или превысил лимит ожидания');
 await event(pool,row.project_id,runId,'health','Проверка HTTPS после успешного GitHub Actions');
 for(let attempt=0;attempt<3;attempt++){
  const response=await fetch(row.health_url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw problem(502,'Приложение недоступно: HTTP '+response.status);
  if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1500));
 }
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const updated=await client.query("UPDATE task_deployment_records SET status='automatic_verified',reason=$3,updated_at=now() WHERE task_id=$1 AND project_id=$2 AND status='pending' RETURNING task_id",
   [row.task_id,row.project_id,'SHA '+commit+' / GitHub Actions #'+githubRunId+' / '+row.health_url]);
  if(!updated.rowCount)throw problem(409,'Задача больше не ожидает выкладку');
  const task=await client.query("UPDATE tasks SET stage='documentation',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='deployment' RETURNING id",
   [row.task_id,row.project_id]);
  if(!task.rowCount)throw problem(409,'Этап задачи изменился');
  await client.query("UPDATE deployment_runs SET status='completed',message='Выкладка SHA и доступность проверены',updated_at=now(),completed_at=now() WHERE id=$1",[runId]);
  await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'deployment_verified',$3)",[randomUUID(),row.task_id,'SHA '+commit+' / run '+githubRunId]);
  await event(client,row.project_id,runId,'completed','GitHub Actions и HTTPS проверены для '+commit);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function failAutomaticDeployment(db:Db,runId:string,message:string){
 const row=await db.query("UPDATE deployment_runs SET status='failed',message=$2,updated_at=now(),completed_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING project_id",
  [runId,message.slice(0,1200)]);
 if(row.rowCount)await event(db,row.rows[0].project_id,runId,'failed',message);
}
