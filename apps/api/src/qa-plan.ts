import {composeAgentPrompt} from './agent-prompt.js';
import type { Pool } from 'pg';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import {taskNotesContext} from './task-agent-notes.js';

const generated=z.object({
 summary:z.string().trim().min(10).max(3000),
 flows:z.array(z.object({
  title:z.string().trim().min(3).max(240),
  description:z.string().max(3000),
  preconditions:z.string().max(3000),
  steps:z.array(z.string().trim().min(3).max(1000)).min(1).max(20)
 })).min(1).max(6),
 cases:z.array(z.object({
  title:z.string().trim().min(3).max(240),
  area:z.string().trim().min(2).max(100),
  flow_title:z.string().max(240).optional(),
  description:z.string().max(3000),
  preconditions:z.string().max(3000),
  steps:z.array(z.object({action:z.string().trim().min(3).max(1200),expected:z.string().trim().min(3).max(1200)})).min(1).max(20),
  priority:z.enum(['critical','high','normal','low']),
  category:z.enum(['smoke','regression','functional']),
  execution_mode:z.enum(['automated','manual','hybrid'])
 })).min(1).max(12),
 regression_case_ids:z.array(z.string().uuid()).max(20).default([])
});

function parseResponse(raw:string){
 const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
 if(first<0||last<=first)throw new Error('AI-тестировщик не вернул JSON тест-плана');
 return generated.parse(JSON.parse(raw.slice(first,last+1)));
}

export type QaTestCase={id:string;title:string;area:string;description:string;preconditions:string;steps:Array<{action:string;expected:string}>;priority:string;category:string;execution_mode:string;purpose:string};

export async function readQaPlan(pool:Pool,projectId:string,taskId:string):Promise<{summary:string;spec_version:number;spec_hash:string;cases:QaTestCase[]}|null>{
 const plan=await pool.query('SELECT id,summary,spec_version,spec_hash FROM qa_test_plans WHERE project_id=$1 AND task_id=$2',[projectId,taskId]);
 if(!plan.rowCount)return null;
 const cases=await pool.query('SELECT c.id,c.title,c.area,c.description,c.preconditions,c.steps,c.priority,c.category,c.execution_mode,p.purpose FROM qa_plan_cases p JOIN qa_test_cases c ON c.id=p.case_id WHERE p.plan_id=$1 AND c.project_id=$2 AND c.status=\'active\' ORDER BY CASE p.purpose WHEN \'targeted\' THEN 0 ELSE 1 END,c.priority,c.title',[plan.rows[0].id,projectId]);
 return {summary:plan.rows[0].summary,spec_version:plan.rows[0].spec_version,spec_hash:plan.rows[0].spec_hash,cases:cases.rows};
}

export async function prepareQaDocumentation(pool:Pool,args:{projectId:string;taskId:string;runId:string;implementationEvidence?:string},ask:(prompt:string)=>Promise<string>):Promise<number>{
 const {projectId,taskId}=args;
 const [task,stage,rules,docs,existing]=await Promise.all([
  pool.query('SELECT title,description,analysis_state,spec_version,spec_reviewed_version,spec_review_status FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]),
  pool.query("SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage='testing'",[projectId]),
  pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 8',[projectId]),
  pool.query("SELECT title,body FROM documents WHERE project_id=$1 AND (document_kind='functional' OR implementation_status='implemented') ORDER BY updated_at DESC LIMIT 2",[projectId]),
  pool.query("SELECT id,title,area,description,priority,category FROM qa_test_cases WHERE project_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 16",[projectId])
 ]);
 if(!task.rowCount)throw new Error('Задача для подготовки QA не найдена');
 if(task.rows[0].analysis_state!=='approved')throw new Error('Сначала требуется утвердить анализ задачи');
 if(task.rows[0].spec_review_status!=='current'||task.rows[0].spec_version!==task.rows[0].spec_reviewed_version)throw new Error('Требования должны быть актуализированы аналитиком перед генерацией тестов');
 const row=task.rows[0];
 const rulesText=rules.rows.map((r:any)=>r.body).join('\n').slice(0,9000);
 const instructions=String(stage.rows[0]?.agent_instructions||'').slice(0,7000);
 const hash=createHash('sha256').update(JSON.stringify({title:row.title,description:row.description,spec_version:row.spec_version,rulesText,instructions})).digest('hex');
 const plan=await pool.query('SELECT id,spec_hash FROM qa_test_plans WHERE project_id=$1 AND task_id=$2',[projectId,taskId]);
 if(plan.rowCount&&plan.rows[0].spec_hash===hash){
  const count=await pool.query('SELECT count(*)::int AS count FROM qa_plan_cases WHERE plan_id=$1',[plan.rows[0].id]);
  if(count.rows[0].count>0)return count.rows[0].count;
 }
 const prompt=composeAgentPrompt({
  role:String(stage.rows[0]?.agent_name||'Независимый QA-инженер'),
  objective:'Подготовь 1–6 сценариев и 1–12 конкретных тест-кейсов по актуальному ТЗ. Не подгоняй ожидаемые результаты под код.\nЗадача: '+row.title+'\n'+String(row.description||'').slice(0,8500),
  instructions:instructions.slice(0,1600),
  scope:'Проект '+projectId+', задача '+taskId+', версия ТЗ '+row.spec_version,
  tools:'Это составление тест-плана, а не выполнение тестов. Не утверждай, что тесты запускались.',
  context:[
   'Правила проекта: '+rulesText.slice(0,800),
   'Комментарии специалистов: '+(await taskNotesContext(pool,projectId,taskId,'testing')).slice(0,850),
   'Изменения реализации для выбора проверок (не менять ожидаемое поведение): '+String(args.implementationEvidence||'').slice(0,1200),
   'Связанные требования: '+JSON.stringify(docs.rows.map((d:any)=>({title:d.title,body:String(d.body).slice(0,480)}))).slice(0,1100),
   'Существующие регрессионные кейсы для выбора: '+JSON.stringify(existing.rows.map((x:any)=>({id:x.id,title:x.title,category:x.category}))).slice(0,1800)
  ].join('\n'),
  output:'Верни строго JSON: {"summary":"...","flows":[{"title":"...","description":"...","preconditions":"...","steps":["..."]}],"cases":[{"title":"...","area":"...","flow_title":"...","description":"...","preconditions":"...","steps":[{"action":"...","expected":"..."}],"priority":"critical|high|normal|low","category":"smoke|regression|functional","execution_mode":"automated|manual|hybrid"}],"regression_case_ids":["uuid"]}. Включи позитивные, негативные и крайние случаи.'
 });
 const produced=parseResponse(await ask(prompt));
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const spec=await client.query('SELECT spec_version,spec_reviewed_version,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,projectId]);
  if(!spec.rowCount||spec.rows[0].spec_version!==row.spec_version||spec.rows[0].spec_review_status!=='current'||spec.rows[0].spec_reviewed_version!==row.spec_version)
   throw new Error('ТЗ изменилось во время формирования тест-кейсов. Повтори подготовку по новой версии.');
  const current=await client.query('SELECT id,spec_hash FROM qa_test_plans WHERE project_id=$1 AND task_id=$2 FOR UPDATE',[projectId,taskId]);
  if(current.rowCount&&current.rows[0].spec_hash===hash){
   const count=await client.query('SELECT count(*)::int AS count FROM qa_plan_cases WHERE plan_id=$1',[current.rows[0].id]);
   if(count.rows[0].count>0){await client.query('COMMIT');return count.rows[0].count;}
  }
  const planId=current.rowCount?current.rows[0].id:randomUUID();
  if(current.rowCount){
   await client.query('DELETE FROM qa_plan_cases WHERE plan_id=$1',[planId]);
   await client.query('UPDATE qa_test_plans SET summary=$2,spec_hash=$3,spec_version=$4,generated_at=now() WHERE id=$1',[planId,produced.summary,hash,row.spec_version]);
  }else{
   await client.query('INSERT INTO qa_test_plans(id,project_id,task_id,spec_hash,summary,spec_version) VALUES($1,$2,$3,$4,$5,$6)',[planId,projectId,taskId,hash,produced.summary,row.spec_version]);
  }
  const flowIds=new Map<string,string>();
  for(const flow of produced.flows){
   const id=randomUUID();
   await client.query('INSERT INTO qa_user_flows(id,project_id,source_task_id,title,description,preconditions,steps) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[id,projectId,taskId,flow.title,flow.description,flow.preconditions,JSON.stringify(flow.steps)]);
   const stored=await client.query('SELECT id FROM qa_user_flows WHERE project_id=$1 AND lower(title)=lower($2)',[projectId,flow.title]);
   flowIds.set(flow.title.toLowerCase(),stored.rows[0].id);
  }
  const selected=new Set<string>();
  for(const candidate of produced.cases){
   const caseId=randomUUID();
   const flowId=flowIds.get(String(candidate.flow_title||'').toLowerCase())||null;
   await client.query('INSERT INTO qa_test_cases(id,project_id,flow_id,source_task_id,title,area,description,preconditions,steps,priority,category,execution_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING',[caseId,projectId,flowId,taskId,candidate.title,candidate.area,candidate.description,candidate.preconditions,JSON.stringify(candidate.steps),candidate.priority,candidate.category,candidate.execution_mode]);
   const stored=await client.query('SELECT id,steps FROM qa_test_cases WHERE project_id=$1 AND lower(title)=lower($2)',[projectId,candidate.title]);
   const stableId=stored.rows[0].id;
   // Existing manually maintained cases are not silently rewritten to match newly generated expectations.
   if(stableId!==caseId&&JSON.stringify(stored.rows[0].steps)!==JSON.stringify(candidate.steps)){
    await client.query("UPDATE qa_test_cases SET status='needs_review' WHERE id=$1",[stableId]);
    // Preserve previous expectations; the needs_review case blocks development until a human reconciles it.
   }
   selected.add(stableId);
   await client.query("INSERT INTO qa_plan_cases(plan_id,case_id,purpose) VALUES($1,$2,'targeted') ON CONFLICT DO NOTHING",[planId,stableId]);
  }
  // Smoke checks are always included; the model cannot suppress mandatory regression.
  const smoke=await client.query("SELECT id FROM qa_test_cases WHERE project_id=$1 AND status='active' AND category='smoke' ORDER BY updated_at DESC LIMIT 10",[projectId]);
  const chosen=[...new Set([...produced.regression_case_ids,...smoke.rows.map((x:any)=>x.id)])].filter(id=>!selected.has(id)).slice(0,20);
  for(const caseId of chosen){
   const valid=await client.query("SELECT 1 FROM qa_test_cases WHERE id=$1 AND project_id=$2 AND status='active'",[caseId,projectId]);
   if(valid.rowCount)await client.query("INSERT INTO qa_plan_cases(plan_id,case_id,purpose) VALUES($1,$2,'regression') ON CONFLICT DO NOTHING",[planId,caseId]);
  }
  await client.query('COMMIT');
  return selected.size+chosen.length;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
