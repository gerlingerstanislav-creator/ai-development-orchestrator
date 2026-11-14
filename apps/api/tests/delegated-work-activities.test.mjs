import test from 'node:test';
import assert from 'node:assert/strict';
import {createDelegatedWorkActivities} from '../dist/modules/agents/application/delegated-work-activities.js';

function harness({status='running',agentsRunning=true,stage='development',spec=3,currentSpec=3,
 enabled=true,output='work finished',error=null,toolGrants=['browser.session']}={}){
 const calls={queries:[],prompts:[],completion:[],finalized:[],settings:[],audit:[]};
 const item={id:'assignment',project_id:'project',task_id:'task',role:'testing',
  title:'Verify UI',task_description:'Check behavior',objective:'Take screenshots',
  acceptance:'Real screenshots',status,stage,spec_version:spec,current_spec:currentSpec,
  agents_running:agentsRunning,granted_tools:toolGrants};
 const pool={query:async(sql,values)=>{
  calls.queries.push({sql,values});
  if(sql.includes('SELECT a.*,COALESCE(t.title,g.objective)'))return {rows:status==='running'?[item]:[],rowCount:status==='running'?1:0};
  if(sql.includes('SELECT model,reasoning,enabled FROM project_ai_settings'))
   return {rows:[{model:'base',reasoning:'low',enabled}],rowCount:1};
  if(sql.includes('SELECT agent_instructions FROM workflow_stages'))
   return {rows:[{agent_instructions:'Follow approved QA instructions'}],rowCount:1};
  throw Error('Unexpected SQL: '+sql);
 }};
 const service=createDelegatedWorkActivities({
  pool,
  resolveSettings:async(_db,projectId,role,defaults)=>{
   calls.settings.push({projectId,role,defaults});
   return {model:'role-selected',reasoning:'high',enabled:true};
  },
  recordPrompt:async(_db,x)=>{calls.audit.push(x);},
  askRunnerAssistant:async(...params)=>{
   calls.completion.push(params);
   if(error)throw error;
   return output;
  },
  finalize:async(_db,id,reason)=>{
   calls.finalized.push({id,reason});
   return {status:'blocked'};
  }
 });
 return {service,calls};
}
test('no active running assignment is a no-op and never starts Codex',async()=>{
 const {service,calls}=harness({status:'submitted'});
 await service.runDelegatedWork('assignment');
 assert.equal(calls.completion.length,0);
 assert.equal(calls.finalized.length,0);
});
test('stopped project or stale specification never launches a specialist',async()=>{
 for(const option of [{agentsRunning:false},{stage:'done'},{spec:2,currentSpec:3}]){
  const {service,calls}=harness(option);
  await service.runDelegatedWork('assignment');
  assert.equal(calls.completion.length,0);
  assert.equal(calls.finalized.length,1);
  assert.match(calls.finalized[0].reason,/актуальность|остановлены/);
 }
});
test('disabled AI is a documented blocker rather than an artificial success',async()=>{
 const {service,calls}=harness({enabled:false});
 await service.runDelegatedWork('assignment');
 assert.equal(calls.finalized.length,1);
 assert.match(calls.finalized[0].reason,/AI отключён/);
 assert.equal(calls.completion.length,0);
});
test('agent role, scoped grants, acceptance and instructions are sent to the same Runner',async()=>{
 const {service,calls}=harness({output:'Done'});
 await service.runDelegatedWork('assignment');
 assert.deepEqual(calls.settings.map(s=>[s.projectId,s.role]),[['project','testing']]);
 assert.equal(calls.completion.length,1);
 const [prompt,project,task,operation,ai,timeout,images,reader]=calls.completion[0];
 assert.equal(project,'project');assert.equal(task,'task');
 assert.equal(operation,'delegated_work');assert.equal(timeout,195000);
 assert.deepEqual(images,[]);
 assert.deepEqual(ai,{model:'role-selected',reasoning:'high',enabled:true});
 assert.deepEqual(reader,{role:'testing',processId:'assignment'});
 assert.match(prompt,/Take screenshots/);
 assert.match(prompt,/Real screenshots/);
 assert.match(prompt,/browser\.session/);
 assert.match(prompt,/Follow approved QA instructions/);
 assert.match(prompt,/work\.report/);
 assert.equal(calls.audit.length,1);
 assert.equal(calls.audit[0].operation,'delegated_work');
 assert.equal(calls.finalized.length,1);
 assert.match(calls.finalized[0].reason,/без подтверждённого результата/);
});
test('a model response never marks delegated work completed without work.report',async()=>{
 const {service,calls}=harness({output:'Я всё сделал и создал PR'});
 await service.runDelegatedWork('assignment');
 assert.equal(calls.finalized.length,1);
 assert.match(calls.finalized[0].reason,/work\.report/);
});
test('runner failures produce a bounded blocker and preserve evidence from tools',async()=>{
 const {service,calls}=harness({error:new Error('Runner unavailable')});
 await service.runDelegatedWork('assignment');
 assert.equal(calls.finalized.length,1);
 assert.match(calls.finalized[0].reason,/Сбой исполнителя: Error: Runner unavailable/);
});
test('Temporal failure reports a blocked assignment with a diagnostic reason',async()=>{
 const {service,calls}=harness();
 await service.failDelegatedWork('assignment','worker crashed');
 assert.deepEqual(calls.finalized.map(x=>x.reason),['Ошибка Temporal: worker crashed']);
});
