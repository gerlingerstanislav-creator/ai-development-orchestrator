import {executeAgentTool} from '../dist/agent-tool-executor.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {checkedWithActualCapabilities,isVisualAcceptanceCase} from '../dist/qa-evidence.js';
import {isPrEvidenceRequest,managerRequestText,registerProjectManagerRoutes,tasksWithCustomerQuestions} from '../dist/project-manager.js';

test('browserless QA cannot certify a visual circle layout by reading CSS',()=>{
 const planned=[{id:'circle',title:'Фигуры расположены по окружности и стрелки видны',
  steps:[{action:'Открыть страницу в браузере',expected:'Фигуры по окружности, стрелки не пересекаются'}]}];
 const reported=[{case_id:'circle',result:'passed',reason:'executed',evidence:'Read CSS and concluded that positions are correct'}];
 const result=checkedWithActualCapabilities(planned,reported,
  'chromium: unavailable\nchromium-browser: unavailable\ngoogle-chrome: unavailable\nplaywright: unavailable');
 assert.equal(isVisualAcceptanceCase(planned[0]),true);
 assert.equal(result.visualToolGap,true);
 assert.equal(result.cases[0].result,'blocked');
 assert.equal(result.cases[0].reason,'tool_unavailable');
 assert.match(result.cases[0].evidence,/не запускалась/);
});
test('real browser capability does not replace actual per-case evidence',()=>{
 const planned=[{id:'layout',title:'Responsive layout'}];
 const reported=[{case_id:'layout',result:'not_run',reason:'unknown',evidence:'No checks'}];
 const result=checkedWithActualCapabilities(planned,reported,'chromium: available\nplaywright: available');
 assert.equal(result.visualToolGap,false);
 assert.equal(result.cases[0].result,'not_run');
});
test('non-visual server checks may pass without browser',()=>{
 const planned=[{id:'api',title:'API returns 200 and schema matches'}];
 const reported=[{case_id:'api',result:'passed',reason:'executed',evidence:'curl returned 200 and API schema matched'}];
 const result=checkedWithActualCapabilities(planned,reported,'chromium: unavailable');
 assert.equal(result.visualToolGap,false);
 assert.equal(result.cases[0].result,'passed');
});
test('the manager asks for an explicit decision without asserting that skipped tests passed',()=>{
 const message=managerRequestText('qa_visual',{assessment:{passed:2,total:5,unverified:[
  {title:'Circle layout',evidence:'Chrome browser not installed'},
  {title:'Responsive arrows',evidence:'No browser screenshot tool'},
  {title:'Viewport 360',evidence:'No device emulator'}
 ]}});
 assert.match(message,/Менеджер|Тестировщик|Тестировщик/);
 assert.match(message,/не смог проверить 3 сценариев/);
 assert.match(message,/ждём появления инструментов/);
 assert.match(message,/не объявляю эти проверки успешными/);
});

test('legacy requests for PR evidence are distinct from acceptance decisions',()=>{
 assert.equal(isPrEvidenceRequest('Аналитику нужен полный diff PR по ветке задачи'),true);
 assert.equal(isPrEvidenceRequest('Предоставьте доступ к исходному коду'),true);
 assert.equal(isPrEvidenceRequest('Нужно ли оставлять стрелки между фигурами?'),false);
 assert.equal(isPrEvidenceRequest('Согласовать изменение критериев приёмки?'),false);
});

test('a durable manager turn continues idle development and respects open decisions',async t=>{
 const app=Fastify();
 t.after(()=>app.close());
 const projectId='00000000-0000-4000-8000-000000000001';
 const taskId='00000000-0000-4000-8000-000000000002';
 const messageId='00000000-0000-4000-8000-000000000003';
 const actorId='00000000-0000-4000-8000-000000000004';
 let requests=[],active=[],calls=0;
 const pool={query:async sql=>{
  if(sql.startsWith('SELECT m.actor_id'))return {rows:[{actor_id:actorId,email:'admin@example.org'}]};
  if(sql.startsWith('SELECT id,stage,spec_review_status'))return {rows:[{stage:'development'}]};
  if(sql.startsWith('SELECT id,title,description,stage'))return {rowCount:1,rows:[{stage:'development'}]};
  if(sql.startsWith('SELECT id,kind,source_id'))return {rows:requests};
  if(sql.startsWith('SELECT workflow_id,kind'))return {rows:active};
  return {rows:[]};
 }};
 registerProjectManagerRoutes(app,{pool,workerSecret:'worker-test-secret',uid:req=>req.userId,
  decideAction:async()=>{throw Error('Legacy recovery does not interpret chat');},
  workerAuthorization:async actor=>{assert.equal(actor,actorId);return 'Bearer scoped-test';},
  access:async caller=>caller.userId===actorId,requireAdmin:async caller=>caller.userId===actorId,
  startManagerWorkflow:async()=>{},recoverTask:async input=>{
   calls++;
   assert.deepEqual(input,{projectId,taskId,auth:'Bearer scoped-test',cookie:''});
   return {ok:true,status:202,message:'Разработка запущена'};
  }
 });
 const turn=secret=>app.inject({method:'POST',url:'/internal/manager/continue',
  headers:{'x-runner-secret':secret},payload:{projectId,taskId,messageId}});
 assert.equal((await turn('wrong')).statusCode,403);
 assert.deepEqual((await turn('worker-test-secret')).json(),{message:'Разработка запущена'});
 requests=[{kind:'requirements',status:'open'}];
 assert.deepEqual((await turn('worker-test-secret')).json(),{message:''});
 requests=[];active=[{kind:'development'}];
 assert.match((await turn('worker-test-secret')).json().message,/уже работает/);
 assert.equal(calls,1);
});

test('answers in task chat update analysis and an explicit start can recover an earlier answer',async t=>{
 const app=Fastify();
 t.after(()=>app.close());
 const projectId='00000000-0000-4000-8000-000000000001';
 const taskId='00000000-0000-4000-8000-000000000002';
 const messageId='00000000-0000-4000-8000-000000000003';
 const actorId='00000000-0000-4000-8000-000000000004';
 const answer='Внутренний круг внутри всей группы фигур.';
 const statusQuestion='Какой статус задачи?';
 const startCommand='Пусть разработчик возьмёт эту карточку прямо сейчас';
 let text=answer,action='clarify',questions=['Где должен быть внутренний круг?'],starts=0,analysisCalls=0,reviewed=false,allowLaunch=true;
 let remaining=[];
 const pool={query:async(sql,params)=>{
  if(sql.startsWith('SELECT m.actor_id'))return {rows:[{actor_id:actorId,email:'admin@example.org',body:text,created_at:new Date('2026-11-09T20:00:00Z')}]};
  if(sql.startsWith('SELECT id,stage,spec_review_status'))return {rows:[{stage:'analysis',clarification_questions:questions}]};
  if(sql.startsWith('SELECT id,title,description,stage'))return {rowCount:1,rows:[{stage:'analysis'}]};
  if(sql.startsWith('SELECT id,kind,source_id'))return {rows:questions.length?[{kind:'analysis_clarifications',status:'open',created_at:new Date('2026-11-09T19:00:00Z')}]:[]};
  if(sql.startsWith('SELECT body,status FROM manager_messages')){
   assert.equal(params[2],actorId);
   return {rows:[{body:statusQuestion,status:'completed'},{body:'@QA Какие есть сценарии?',status:'completed'},{body:answer,status:'completed'}]};
  }
  return {rows:[]};
 }};
 app.post('/api/projects/:projectId/tasks/:taskId/assistant',async req=>{
  analysisCalls++;
  assert.equal(req.headers.authorization,'Bearer scoped-test');
  assert.equal(req.body.mode,'clarification');
  assert.equal(req.body.message,action==='start_development'?answer+'\n\n'+statusQuestion+'\n\n'+text:answer);
  reviewed=true;
  questions=remaining;
  return {message:'ТЗ уточнено.',questions};
 });
 app.post('/api/projects/:projectId/tasks/:taskId/approve-development',async(req,reply)=>{
  starts++;
  assert.equal(reviewed,true);
  return allowLaunch?reply.code(202).send({status:'queued'}):reply.code(409).send({error:'Нет подключения GitHub'});
 });
 registerProjectManagerRoutes(app,{pool,workerSecret:'worker-test-secret',uid:req=>req.userId,
  decideAction:async input=>{
   assert.equal(input.message,text);
   assert.equal(input.snapshot.task.stage,'analysis');
   return {action};
  },
  workerAuthorization:async()=>'Bearer scoped-test',access:async()=>true,requireAdmin:async()=>true,
  startManagerWorkflow:async()=>{},recoverTask:async()=>{throw Error('Analysis must use its own guarded transition');}
 });
 const turn=()=>app.inject({method:'POST',url:'/internal/manager/continue',
  headers:{'x-runner-secret':'worker-test-secret'},payload:{projectId,taskId,messageId,analysisActions:true}});
 text=statusQuestion;
 action='reply';
 assert.deepEqual((await turn()).json(),{message:''});
 assert.equal(analysisCalls,0);
 text='Отправь задачу в разработку';
 action='unknown';
 assert.match((await turn()).json().message,/Не удалось обработать/);
 assert.equal(starts,0);
 assert.equal(analysisCalls,0);
 text=answer;
 action='clarify';
 remaining=['Какого цвета должен быть круг?'];
 assert.deepEqual((await turn()).json(),{message:'ТЗ уточнено.',handled:true});
 assert.equal(starts,0,'A partial answer leaves the task waiting');

 remaining=[];
 const result=(await turn()).json();
 assert.match(result.message,/ТЗ уточнено.*запуск принят/si);
 assert.equal(result.handled,true);
 assert.equal(analysisCalls,2);
 assert.equal(starts,1);

 allowLaunch=false;
 text=startCommand;
 action='start_development';
 assert.deepEqual((await turn()).json(),{message:'Нет подключения GitHub',handled:true});
 assert.equal(analysisCalls,2,'Launch on a ready task does not call the analyst again');

 questions=['Где должен быть внутренний круг?'];reviewed=false;allowLaunch=true;
 assert.match((await turn()).json().message,/ТЗ уточнено.*запуск принят/si);
 assert.equal(analysisCalls,3,'An explicit launch can still recover an earlier answer');
});


test('owner questions project onto the board without changing task stages',async()=>{
 const defaults={open_notes:[],material_review:false,blocked_qa:null};
 const rows=[
  {...defaults,id:'new',stage:'analysis',clarification_questions:['Какого цвета должен быть круг?']},
  {...defaults,id:'internal',stage:'development',open_notes:['Аналитику нужен полный diff PR по ветке задачи']},
  {...defaults,id:'later',stage:'testing',open_notes:['Нужно ли оставлять стрелки?']},
  {...defaults,id:'resolved',stage:'analysis',clarification_questions:[]},
  {...defaults,id:'review',stage:'merge_queue',spec_review_status:'needs_approval',material_review:true}
 ];
 const db={query:async(_sql,params)=>{
  assert.deepEqual(params,['project']);
  return {rows};
 }};
 const tasks=await tasksWithCustomerQuestions(db,'project');
 assert.deepEqual(tasks.map(task=>[task.id,task.stage,task.awaits_product_owner]),[
  ['new','analysis',true],['internal','development',false],['later','testing',true],
  ['resolved','analysis',false],['review','merge_queue',true]
 ]);
 const result=await executeAgentTool(db,{project_id:'project',role:'manager'},'tasks.list',
  {product_owner_questions_only:true});
 assert.deepEqual(result.tasks.map(task=>[task.id,task.stage]),[
  ['new','analysis'],['later','testing'],['review','merge_queue']
 ]);
});

test('a pending manager reply can be interrupted without cancelling the task workflow',async t=>{
 const app=Fastify();
 t.after(()=>app.close());
 const projectId='00000000-0000-4000-8000-000000000001';
 const taskId='00000000-0000-4000-8000-000000000002';
 const messageId='00000000-0000-4000-8000-000000000003';
 const actorId='00000000-0000-4000-8000-000000000004';
 let status='processing',cancelled=0;
 const pool={query:async(sql,params)=>{
  if(sql.startsWith("UPDATE manager_messages SET status='cancelled'")){
   if(status!=='processing')return {rowCount:0,rows:[]};
   assert.deepEqual(params,[messageId,projectId,taskId,actorId]);
   status='cancelled';
   return {rowCount:1,rows:[{id:messageId}]};
  }
  return {rows:[],rowCount:0};
 }};
 registerProjectManagerRoutes(app,{pool,workerSecret:'worker-test-secret',uid:()=>actorId,
  access:async()=>true,requireAdmin:async()=>true,workerAuthorization:async()=>'',decideAction:async()=>({action:'reply'}),
  startManagerWorkflow:async()=>{},stopManagerWorkflow:async id=>{assert.equal(id,messageId);cancelled++;},
  recoverTask:async()=>{throw Error('Stopping a PM reply must not resume or cancel task execution');}
 });
 const url='/api/projects/'+projectId+'/tasks/'+taskId+'/manager/messages/'+messageId+'/stop';
 const first=await app.inject({method:'POST',url,payload:{}});
 assert.equal(first.statusCode,200,first.body);
 assert.equal(first.json().status,'cancelled');
 assert.equal(cancelled,1);
 const duplicate=await app.inject({method:'POST',url,payload:{}});
 assert.equal(duplicate.statusCode,409,duplicate.body);
 assert.equal(cancelled,1);
});
