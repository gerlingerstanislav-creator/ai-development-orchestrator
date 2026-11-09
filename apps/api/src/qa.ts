import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid=z.string().uuid();
const step=z.object({action:z.string().trim().min(3).max(1200),expected:z.string().trim().min(3).max(1200)});
const casePayload=z.object({
 title:z.string().trim().min(3).max(240),
 area:z.string().trim().min(2).max(100),
 description:z.string().max(3000).default(''),
 preconditions:z.string().max(3000).default(''),
 steps:z.array(step).min(1).max(20),
 priority:z.enum(['critical','high','normal','low']).default('normal'),
 category:z.enum(['smoke','regression','functional']).default('functional'),
 execution_mode:z.enum(['automated','manual','hybrid']).default('hybrid'),
 status:z.enum(['active','needs_review','archived']).default('active'),
 flow_id:uuid.nullable().optional()
});
const flowPayload=z.object({
 title:z.string().trim().min(3).max(240),
 description:z.string().max(3000).default(''),
 preconditions:z.string().max(3000).default(''),
 steps:z.array(z.string().trim().min(3).max(1000)).min(1).max(20)
});

export async function initQaSchema(pool:Pool){
 await pool.query([
  'CREATE TABLE IF NOT EXISTS qa_user_flows (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL, title text NOT NULL, description text NOT NULL DEFAULT \'\', preconditions text NOT NULL DEFAULT \'\', steps jsonb NOT NULL DEFAULT \'[]\'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())',
  'CREATE UNIQUE INDEX IF NOT EXISTS qa_flow_title ON qa_user_flows(project_id,lower(title))',
  'CREATE TABLE IF NOT EXISTS qa_test_cases (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, flow_id uuid REFERENCES qa_user_flows(id) ON DELETE SET NULL, source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL, title text NOT NULL, area text NOT NULL DEFAULT \'general\', description text NOT NULL DEFAULT \'\', preconditions text NOT NULL DEFAULT \'\', steps jsonb NOT NULL DEFAULT \'[]\'::jsonb, priority text NOT NULL DEFAULT \'normal\', category text NOT NULL DEFAULT \'functional\', execution_mode text NOT NULL DEFAULT \'hybrid\', status text NOT NULL DEFAULT \'active\', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())',
  'CREATE UNIQUE INDEX IF NOT EXISTS qa_case_title ON qa_test_cases(project_id,lower(title))',
  'CREATE INDEX IF NOT EXISTS qa_case_area ON qa_test_cases(project_id,area,status)',
  'CREATE TABLE IF NOT EXISTS qa_test_plans (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE, spec_hash text NOT NULL, summary text NOT NULL DEFAULT \'\', generated_at timestamptz NOT NULL DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS qa_plan_cases (plan_id uuid NOT NULL REFERENCES qa_test_plans(id) ON DELETE CASCADE, case_id uuid NOT NULL REFERENCES qa_test_cases(id) ON DELETE CASCADE, purpose text NOT NULL CHECK(purpose IN (\'targeted\',\'regression\')), PRIMARY KEY(plan_id,case_id))',
  'CREATE TABLE IF NOT EXISTS qa_case_results (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, test_run_id uuid NOT NULL REFERENCES ai_test_runs(id) ON DELETE CASCADE, case_id uuid NOT NULL REFERENCES qa_test_cases(id) ON DELETE CASCADE, result text NOT NULL CHECK(result IN (\'passed\',\'failed\',\'blocked\',\'not_run\')), evidence text NOT NULL DEFAULT \'\', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(test_run_id,case_id))',
  'CREATE TABLE IF NOT EXISTS qa_case_versions (id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES qa_test_cases(id) ON DELETE CASCADE, changed_by uuid REFERENCES users(id) ON DELETE SET NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())'
 ].join(';\n')+';');
}

type Deps={pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>;uid:(req:any)=>string};
export function registerQaRoutes(app:FastifyInstance,{pool,access,requireAdmin,uid}:Deps){
 app.get('/api/projects/:id/qa',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const [flows,cases,plans,results]=await Promise.all([
   pool.query('SELECT f.*,t.display_number AS task_number FROM qa_user_flows f LEFT JOIN tasks t ON t.id=f.source_task_id WHERE f.project_id=$1 ORDER BY f.updated_at DESC LIMIT 300',[id]),
   pool.query('SELECT c.*,t.display_number AS task_number FROM qa_test_cases c LEFT JOIN tasks t ON t.id=c.source_task_id WHERE c.project_id=$1 ORDER BY c.updated_at DESC LIMIT 600',[id]),
   pool.query('SELECT p.*,t.display_number AS task_number,t.title AS task_title,COALESCE(jsonb_agg(jsonb_build_object(\'id\',pc.case_id,\'purpose\',pc.purpose)) FILTER (WHERE pc.case_id IS NOT NULL),\'[]\'::jsonb) AS cases FROM qa_test_plans p JOIN tasks t ON t.id=p.task_id LEFT JOIN qa_plan_cases pc ON pc.plan_id=p.id WHERE p.project_id=$1 GROUP BY p.id,t.display_number,t.title ORDER BY p.generated_at DESC LIMIT 100',[id]),
   pool.query('SELECT r.case_id,r.result,r.evidence,r.created_at,r.test_run_id,t.task_id FROM qa_case_results r JOIN ai_test_runs t ON t.id=r.test_run_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 200',[id])
  ]);
  return {flows:flows.rows,cases:cases.rows,plans:plans.rows,results:results.rows};
 });
 app.post('/api/projects/:id/qa/flows',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const data=flowPayload.parse(req.body),flowId=randomUUID();
  const result=await pool.query('INSERT INTO qa_user_flows(id,project_id,title,description,preconditions,steps) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[flowId,id,data.title,data.description,data.preconditions,JSON.stringify(data.steps)]);
  if(!result.rowCount)return reply.code(409).send({error:'Сценарий с таким названием уже существует'});
  return reply.code(201).send({id:flowId});
 });
 app.post('/api/projects/:id/qa/cases',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const data=casePayload.parse(req.body);
  if(data.flow_id){
   const flow=await pool.query('SELECT 1 FROM qa_user_flows WHERE id=$1 AND project_id=$2',[data.flow_id,id]);
   if(!flow.rowCount)return reply.code(400).send({error:'Сценарий не принадлежит проекту'});
  }
  const caseId=randomUUID();
  const result=await pool.query('INSERT INTO qa_test_cases(id,project_id,flow_id,title,area,description,preconditions,steps,priority,category,execution_mode,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id',[caseId,id,data.flow_id||null,data.title,data.area,data.description,data.preconditions,JSON.stringify(data.steps),data.priority,data.category,data.execution_mode,data.status]);
  if(!result.rowCount)return reply.code(409).send({error:'Тест-кейс с таким названием уже существует'});
  return reply.code(201).send({id:caseId});
 });
 app.patch('/api/projects/:id/qa/cases/:caseId',async(req:any,reply)=>{
  const {id,caseId}=z.object({id:uuid,caseId:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const data=casePayload.parse(req.body);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const old=await client.query('SELECT * FROM qa_test_cases WHERE id=$1 AND project_id=$2 FOR UPDATE',[caseId,id]);
   if(!old.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Тест-кейс не найден'});}
   if(data.flow_id){
    const flow=await client.query('SELECT 1 FROM qa_user_flows WHERE id=$1 AND project_id=$2',[data.flow_id,id]);
    if(!flow.rowCount){await client.query('ROLLBACK');return reply.code(400).send({error:'Сценарий не принадлежит проекту'});}
   }
   const conflicting=await client.query('SELECT 1 FROM qa_test_cases WHERE project_id=$1 AND lower(title)=lower($2) AND id<>$3',[id,data.title,caseId]);
   if(conflicting.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'Тест-кейс с таким названием уже существует'});}
   await client.query('INSERT INTO qa_case_versions(id,case_id,changed_by,snapshot) VALUES($1,$2,$3,$4)',[randomUUID(),caseId,uid(req),JSON.stringify(old.rows[0])]);
   await client.query('UPDATE qa_test_cases SET title=$1,area=$2,description=$3,preconditions=$4,steps=$5,priority=$6,category=$7,execution_mode=$8,status=$9,flow_id=$10,updated_at=now() WHERE id=$11 AND project_id=$12',[data.title,data.area,data.description,data.preconditions,JSON.stringify(data.steps),data.priority,data.category,data.execution_mode,data.status,data.flow_id||null,caseId,id]);
   await client.query('COMMIT');
   return {ok:true};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
 app.post('/api/projects/:id/qa/cases/:caseId/manual-result',async(req:any,reply)=>{
  const {id,caseId}=z.object({id:uuid,caseId:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {result,evidence}=z.object({result:z.enum(['passed','failed','blocked']),evidence:z.string().trim().min(3).max(4000)}).parse(req.body);
  const c=await pool.query('SELECT 1 FROM qa_test_cases WHERE id=$1 AND project_id=$2',[caseId,id]);
  if(!c.rowCount)return reply.code(404).send({error:'Тест-кейс не найден'});
  // Manual observations are not AI test runs; record them separately without forging an AI verdict.
  await pool.query('CREATE TABLE IF NOT EXISTS qa_manual_results (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,case_id uuid NOT NULL REFERENCES qa_test_cases(id) ON DELETE CASCADE,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,result text NOT NULL,evidence text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())');
  await pool.query('INSERT INTO qa_manual_results(id,project_id,case_id,actor_id,result,evidence) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,caseId,uid(req),result,evidence]);
  return reply.code(201).send({ok:true});
 });
}
