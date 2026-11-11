import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {initProjectIterations,proposeIterationPlan,readIteration,registerProjectIterationRoutes,runIterationPlanning} from '../dist/project-iterations.js';
import {toolAllowedForRole} from '../dist/agent-tools.js';

test('iteration scope, preview and launch are separate, project-scoped decisions',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 const schema='iteration_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 t.after(async()=>{await app.close();await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();});
 await db.query(`
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE projects(id uuid PRIMARY KEY);
  CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,body text DEFAULT '',system_key text,updated_at timestamptz DEFAULT now(),knowledge_status text DEFAULT 'approved');
  CREATE TABLE tasks(
   id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,description text,type text,stage text,analysis_state text,
   parent_id uuid REFERENCES tasks(id),depends_on_task_id uuid REFERENCES tasks(id),dependency_source text,position int,git_branch text,pr_url text,
   display_number int DEFAULT 1,spec_version int DEFAULT 1,spec_reviewed_version int DEFAULT 1,spec_review_status text DEFAULT 'current',
   clarification_questions jsonb DEFAULT '[]',spec_reviewed_commit text DEFAULT '',spec_review_note text DEFAULT '',updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE project_ai_settings(project_id uuid PRIMARY KEY,enabled boolean);
  CREATE TABLE workflow_stages(project_id uuid,stage text,agent_instructions text);
  CREATE TABLE project_rules(project_id uuid,body text,created_at timestamptz DEFAULT now());
  CREATE TABLE process_events(id uuid PRIMARY KEY,project_id uuid,process_id uuid,process_kind text,stage text,detail text);
  CREATE TABLE task_spec_versions(id uuid PRIMARY KEY,project_id uuid,task_id uuid REFERENCES tasks(id),version int,title text,description text,origin text,actor_id uuid,reason text,UNIQUE(task_id,version));
  CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid REFERENCES tasks(id),actor_id uuid,event text,detail text);
  CREATE TABLE knowledge_task_links(id uuid PRIMARY KEY,project_id uuid,document_id uuid,task_id uuid,relation text,UNIQUE(project_id,document_id,task_id,relation));
 `);
 await initProjectIterations(db);
 const actor=randomUUID(),project=randomUUID(),other=randomUUID(),source=randomUUID(),foreignSource=randomUUID();
 await db.query('INSERT INTO users VALUES($1)',[actor]);
 await db.query('INSERT INTO projects VALUES($1),($2)',[project,other]);
 await db.query('INSERT INTO project_ai_settings VALUES($1,true)',[project]);
 await db.query("INSERT INTO documents(id,project_id,title) VALUES($1,$2,'ТЗ'),($3,$4,'Чужое ТЗ')",[source,project,foreignSource,other]);
 const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
 registerProjectIterationRoutes(app,{pool,uid:()=>actor,access:async()=>true,requireAdmin:async()=>true});
 const launchCalls=[];
 app.post('/api/projects/:id/tasks/:taskId/run-ai',async(req,reply)=>{
  launchCalls.push({id:req.params.taskId,...req.body});
  return reply.code(202).send({message:'В очереди'});
 });
 const path='/api/projects/'+project+'/iterations';
 const request=(method,url,payload)=>app.inject({method,url,payload});
 const create=await request('POST',path,{title:'MVP',body:'Первый рабочий сценарий',document_ids:[source]});
 assert.equal(create.statusCode,200,create.body);
 const {id}=create.json(),url=path+'/'+id;
 assert.equal((await request('GET','/api/projects/'+other+'/iterations/'+id)).statusCode,404);
 assert.equal((await request('POST',path,{title:'Чужой документ',body:'Scope',document_ids:[foreignSource]})).statusCode,400);
 const scope=await readIteration(db,project,id);
 const proposal={iteration_id:id,expected_revision:1,source_revision:scope.source_revision,
  epics:[{key:'checkout',title:'Оформление',description:'Базовый сценарий',tasks:[
   {key:'form',title:'Форма',description:'Ввод данных',kind:'development',tags:['UI','ui']},
   {key:'order',title:'Заказ',description:'Проверить правила',kind:'analysis',depends_on:'form'}
  ]}]};
 const propose=()=>proposeIterationPlan(db,project,actor,proposal);
 await assert.rejects(propose,{statusCode:409});
 assert.equal((await request('POST',url+'/approve',{expected_revision:1})).statusCode,200);
 assert.equal(toolAllowedForRole('analyst','iterations.prepare_plan'),true);
 assert.equal(toolAllowedForRole('analyst','iterations.recommend_launch'),false);
 const queued=await request('POST',url+'/prepare',{request:'Учти ручное оформление'});
 assert.equal(queued.statusCode,202,queued.body);
 const runId=queued.json().planning_run_id;
 assert.equal((await request('POST',url+'/prepare',{})).json().planning_run_id,runId);
 let calls=0;
 const complete=()=>runIterationPlanning(pool,runId,async(prompt,projectId)=>{
  calls++;
  assert.equal(projectId,project);
  if(calls===1){
   assert.match(prompt,/Ты системный аналитик/);
   assert.match(prompt,/Согласован объём|Ручное оформление/i);
   assert.match(prompt,/Первый рабочий сценарий/);
   return JSON.stringify({epics:proposal.epics});
  }
  if(calls===2){
   assert.match(prompt,/Ты разработчик/);
   return JSON.stringify({subtasks:[{epic_key:'checkout',key:'form-validation',title:'Валидация формы',description:'Добавить и протестировать валидацию полей',tags:['frontend'],depends_on:'form'}]});
  }
  assert.match(prompt,/Ты ПМ/);
  return JSON.stringify({epics:[{...proposal.epics[0],tasks:[...proposal.epics[0].tasks,
   {key:'form-validation',title:'Валидация формы',description:'Добавить и протестировать валидацию полей',kind:'development',tags:['frontend'],depends_on:'form'}]}]});
 });
 await complete();
 await complete();
 assert.equal(calls,3,'Temporal retry does not regenerate a completed draft');
 const status=(await request('GET',url)).json();
 assert.equal(status.planning_runs[0].status,'completed');
 const plan={id:status.planning_runs[0].plan_id};
 const manual=await propose();
 assert.deepEqual(await propose(),manual,'Identical content reuses the same draft');
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,0);
 const planUrl=url+'/plans/'+plan.id;
 const preview=(await request('GET',planUrl)).json();
 assert.equal(preview.items.length,4);
 const publish=(value=preview.preview_revision)=>request('POST',planUrl+'/publish',{confirm:true,preview_revision:value});
 await db.query("UPDATE documents SET updated_at=updated_at+interval '1 second' WHERE id=$1",[source]);
 assert.equal((await publish()).statusCode,409,'Changed source invalidates publication');
 proposal.source_revision=(await readIteration(db,project,id)).source_revision;
 const next=await proposeIterationPlan(db,project,actor,{...proposal,epics:[{...proposal.epics[0],tasks:[...proposal.epics[0].tasks,
  {key:'form-validation',title:'Валидация формы',description:'Добавить и протестировать валидацию полей',kind:'development',tags:['frontend'],depends_on:'form'}]}]});
 const nextUrl=url+'/plans/'+next.id;
 const nextPreview=(await request('GET',nextUrl)).json();
 const firstPublish=await request('POST',nextUrl+'/publish',{confirm:true,preview_revision:nextPreview.preview_revision});
 assert.equal(firstPublish.statusCode,200,firstPublish.body);
 const result=firstPublish.json();
 assert.equal(result.created.length,4);
 assert.deepEqual((await request('POST',nextUrl+'/publish',{confirm:true,preview_revision:nextPreview.preview_revision})).json(),result);
 const {tasks}=await readIteration(db,project,id);
 const epic=tasks.find(task=>task.type==='epic'),form=tasks.find(task=>task.title==='Форма'),order=tasks.find(task=>task.title==='Заказ');
 assert.equal(form.parent_id,epic.id);
 assert.deepEqual(form.tags,['ui']);
 assert.equal(order.depends_on_task_id,form.id);
 assert.equal(order.stage,'analysis');
 assert.equal(order.analysis_state,'new');
 assert.equal(form.analysis_state,'ready_for_development');
 assert.equal((await db.query('SELECT count(*)::int n FROM task_spec_versions')).rows[0].n,3);
 assert.equal((await db.query('SELECT count(*)::int n FROM knowledge_task_links')).rows[0].n,3);
 const changedProposal=structuredClone(proposal);
 changedProposal.epics[0].tasks[0].title='Форма заказа';
 changedProposal.epics[0].tasks[0].description='Ввод и проверка данных';
 changedProposal.epics[0].tasks[0].tags=['frontend'];
 const changePlan=await proposeIterationPlan(db,project,actor,changedProposal);
 const changeUrl=url+'/plans/'+changePlan.id;
 const changePreview=(await request('GET',changeUrl)).json();
 const changedItem=changePreview.items.find(item=>item.key==='form');
 assert.deepEqual(changedItem.changes.sort(),['description','tags','title']);
 assert.ok(changePreview.items.every(item=>item.existing));
 // A task edited after preview invalidates the original snapshot.
 await db.query("UPDATE tasks SET description='Ручное уточнение',updated_at=now() WHERE id=$1",[form.id]);
 assert.equal((await request('POST',changeUrl+'/publish',{confirm:true,preview_revision:changePreview.preview_revision,selected_changes:['form']})).statusCode,409);
 const fresh=(await request('GET',changeUrl)).json();
 const changedPublish=await request('POST',changeUrl+'/publish',{confirm:true,preview_revision:fresh.preview_revision,selected_changes:['form']});
 assert.equal(changedPublish.statusCode,200,changedPublish.body);
 assert.deepEqual(changedPublish.json().updated,[form.id]);
 const after=(await db.query('SELECT title,description,tags,spec_version FROM tasks WHERE id=$1',[form.id])).rows[0];
 assert.equal(after.title,'Форма заказа');
 assert.equal(after.description,'Ввод и проверка данных');
 assert.deepEqual(after.tags,['frontend']);
 assert.equal(Number(after.spec_version),2);
 assert.deepEqual((await request('POST',changeUrl+'/publish',{confirm:true,preview_revision:fresh.preview_revision,selected_changes:['form']})).json(),changedPublish.json());
 const rerun=await propose(),rerunUrl=url+'/plans/'+rerun.id;
 const rerunPreview=(await request('GET',rerunUrl)).json();
 assert.equal(rerunPreview.items.filter(item=>item.existing).length,3);
 assert.deepEqual((await request('POST',rerunUrl+'/publish',{confirm:true,preview_revision:rerunPreview.preview_revision})).json().created,[]);
 assert.equal((await request('POST',url+'/launch',{confirm:true,expected_revision:1,task_ids:[epic.id]})).statusCode,409);
 const start=await request('POST',url+'/launch',{confirm:true,expected_revision:1,task_ids:[form.id,order.id]});
 assert.equal(start.statusCode,200,start.body);
 assert.deepEqual(start.json().results.map(item=>[item.id,item.started]),[[form.id,true],[order.id,false]]);
 assert.deepEqual(launchCalls,[{id:form.id,approveAnalysis:true,iterationApproval:{id,revision:1}}]);
 const tagUpdate=await request('PUT','/api/projects/'+project+'/tasks/'+form.id+'/planning',{iteration_id:id,tags:['Миграция','миграция']});
 assert.deepEqual(tagUpdate.json(),{iteration_id:id,tags:['миграция'],sprint_id:null,version_id:null});
 const sprint=await request('POST','/api/projects/'+project+'/sprints',{name:'Спринт 1',starts_on:'2026-11-16',ends_on:'2026-11-27'});
 assert.equal(sprint.statusCode,200,sprint.body);
 const version=await request('POST','/api/projects/'+project+'/versions',{name:'v1.0'});
 assert.equal(version.statusCode,200,version.body);
 const invalidDates=await request('POST','/api/projects/'+project+'/sprints',{name:'Неверный',starts_on:'2026-11-27',ends_on:'2026-11-16'});
 assert.equal(invalidDates.statusCode,400);
 const opts=(await request('GET','/api/projects/'+project+'/planning-options')).json();
 assert.equal(opts.sprints[0].name,'Спринт 1');
 assert.equal(opts.versions[0].name,'v1.0');
 const assigned=await request('PUT','/api/projects/'+project+'/tasks/'+form.id+'/planning',{
  iteration_id:id,tags:['migration'],sprint_id:sprint.json().id,version_id:version.json().id});
 assert.equal(assigned.statusCode,200,assigned.body);
 assert.equal(assigned.json().sprint_id,sprint.json().id);
 assert.equal(assigned.json().version_id,version.json().id);
 const oldClient=await request('PUT','/api/projects/'+project+'/tasks/'+form.id+'/planning',{iteration_id:id,tags:[]});
 assert.equal(oldClient.json().sprint_id,sprint.json().id,'Legacy clients must not reset sprint');
 assert.equal(oldClient.json().version_id,version.json().id,'Legacy clients must not reset version');
 const clear=await request('PUT','/api/projects/'+project+'/tasks/'+form.id+'/planning',{iteration_id:id,tags:[],sprint_id:null,version_id:null});
 assert.equal(clear.json().sprint_id,null);
 assert.equal(clear.json().version_id,null);
 const foreignSprint=await request('POST','/api/projects/'+other+'/sprints',{name:'Чужой',starts_on:'2026-11-16',ends_on:'2026-11-27'});
 assert.equal((await request('PUT','/api/projects/'+project+'/tasks/'+form.id+'/planning',{
  iteration_id:id,tags:[],sprint_id:foreignSprint.json().id,version_id:null})).statusCode,400);
 const change=await request('PUT',url,{title:'MVP 1',body:scope.body,document_ids:[source],expected_revision:1});
 assert.deepEqual(change.json(),{id,revision:2});
 assert.equal((await request('POST',url+'/approve',{expected_revision:2})).statusCode,200);
 assert.equal((await request('POST',url+'/launch',{confirm:true,expected_revision:1,task_ids:[form.id]})).statusCode,409);
});
