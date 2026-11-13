import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {checkProjectManagerWatch,readProjectManagerWatchResume}
 from '../dist/modules/planning/application/pm-watch-monitor.js';
import {executeProjectManagerInbox} from '../dist/project-manager-inbox.js';

const ids=()=>({projectId:randomUUID(),processId:randomUUID(),orderId:randomUUID(),actorId:randomUUID(),topicId:randomUUID()});

test('Temporal watch remains pending on active QA and cannot approve unverified results',async()=>{
 const watch={...ids(),kind:'testing'};
 const queries=[];
 const pool={query:async sql=>{
  queries.push(sql);
  if(sql.includes('FROM task_orchestration_owners'))return {rowCount:1,rows:[{state:'active',qa_status:'completed',qa_verdict:'passed',name:'My task'}]};
  throw Error('Unexpected write: '+sql);
 }};
 assert.equal(await checkProjectManagerWatch(pool,watch),'pending');
 assert.equal(queries.length,1);
 assert.match(queries[0],/o.kind='testing'/);
});

test('waiting documentation input generates one PM resume with job ID instead of claiming success',async()=>{
 const watch={...ids(),kind:'document_import'};
 const messages=[],events=[],queries=[];
 let reported=false;
 const client={
  async query(sql,params=[]){
   queries.push(sql);
   if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
   if(sql.includes('INSERT INTO project_pm_process_reports')){
    if(reported)return {rowCount:0,rows:[]};
    reported=true;return {rowCount:1,rows:[{process_id:watch.processId}]};
   }
   if(sql.includes('INSERT INTO assistant_messages')){messages.push({sql,params});return {rowCount:1,rows:[]};}
   if(sql.includes('INSERT INTO project_pm_order_events')){events.push({sql,params});return {rowCount:1,rows:[]};}
   if(sql.includes('UPDATE project_pm_orders'))return {rowCount:1,rows:[]};
   throw Error('Unexpected transaction statement '+sql);
  },
  release(){}
 };
 const pool={
  async query(sql){
   if(sql.includes('FROM document_import_jobs')){
    return {rowCount:1,rows:[{status:'waiting_input',message:'Нужен источник',result:{question:'Где находится ТЗ?',context:'Подключённого репозитория нет'}}]};
   }
   if(sql.includes("kind='resume'"))return {rowCount:1,rows:[{detail:events[0]?.params[2]}]};
   throw Error('Unexpected outside query '+sql);
  },
  async connect(){return client;}
 };
 const status=await readProjectManagerWatchResume(pool,watch);
 assert.equal(status.status,'completed');
 assert.equal(messages.length,2,'one user-visible status and one internal PM continuation');
 assert.match(messages[0].params[2],/Аналитик запросил сведения/);
 assert.match(messages[0].params[2],/Где находится ТЗ/);
 assert.match(messages[1].params[3],/documentation\.resume_spec/);
 assert.equal(messages[1].params[5],watch.orderId);
 assert.equal(events.length,1);
 const again=await readProjectManagerWatchResume(pool,watch);
 assert.equal(again.status,'completed');
 assert.equal(messages.length,2,'retries must not queue the same PM instruction again');
 assert.equal(again.messageId,events[0].params[2]);
});

test('QA process report labels blocked evidence as requiring attention, not a passing test',async()=>{
 const watch={...ids(),kind:'testing'};
 const messages=[];
 const client={query:async(sql,params)=>{
  if(sql.includes('INSERT INTO project_pm_process_reports'))return {rowCount:1,rows:[{process_id:watch.processId}]};
  if(sql.includes('INSERT INTO assistant_messages')){messages.push(params);return {rowCount:1,rows:[]};}
  return {rowCount:1,rows:[]};
 },release(){}};
 const pool={
  query:async(sql)=>{
   if(sql.includes('FROM task_orchestration_owners'))return {rowCount:1,rows:[{state:'completed',name:'Feature',qa_status:'completed',qa_verdict:'blocked',qa_summary:'Chromium не подтвердил сценарий'}]};
   throw Error('Unexpected query '+sql);
  },
  connect:async()=>client
 };
 assert.equal(await checkProjectManagerWatch(pool,watch),'completed');
 assert.equal(messages.length,2);
 assert.match(messages[0][2],/требуется внимание/);
 assert.match(messages[0][2],/blocked/);
 assert.doesNotMatch(messages[0][2],/тестирование пройдено/);
});

test('PM inbox maintains original public execution entrypoint for Temporal Activities',()=>{
 assert.equal(typeof executeProjectManagerInbox,'function');
 assert.equal(executeProjectManagerInbox.length,5,'five required arguments; last retry attempt defaults to one');
});
