import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {checkedWithActualCapabilities,isVisualAcceptanceCase} from '../dist/qa-evidence.js';
import {isPrEvidenceRequest,managerRequestText,registerProjectManagerRoutes} from '../dist/project-manager.js';

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
