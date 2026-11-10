import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerSafeTaskDeletion} from '../dist/task-deletion.js';

const projectId='11111111-1111-4111-8111-111111111111';
const questionId='22222222-2222-4222-8222-222222222222';

function setup(active=false){
 const app=Fastify();
 let deleted=0;
 const query=async(sql,params=[])=>{
  if(sql.includes('SELECT t.*'))return {rows:[]};
  if(sql.startsWith('SELECT q.id,q.question'))return {rows:[{
   id:questionId,question:'Уточнить правило оплаты',document_title:'ТЗ',blocked_reason:active?'Вопрос используется активным процессом аналитика':null
  }]};
  if(sql.startsWith('SELECT q.id FROM documentation_questions'))return {rows:active?[]:[{id:questionId}]};
  if(sql.startsWith('DELETE FROM documentation_questions')){
   assert.deepEqual(params,[projectId,[questionId]]);
   deleted++;
   return {rows:[{id:questionId}]};
  }
  if(sql.startsWith('BEGIN')||sql==='COMMIT'||sql==='ROLLBACK'||sql.startsWith('SELECT id FROM documentation_questions'))
   return {rows:[],rowCount:0};
  throw Error('Unexpected query: '+sql.slice(0,110));
 };
 const pool={query,connect:async()=>({query,release(){}})};
 registerSafeTaskDeletion(app,{pool,uid:()=>projectId,access:async()=>true,requireAdmin:async()=>true});
 const endpoint='/api/projects/'+projectId+'/tasks/owner-questions/delete';
 return {app,endpoint,getDeleted:()=>deleted};
}

test('PO column preview includes analyst documentation questions even without task cards',async t=>{
 const {app,endpoint}=setup();
 t.after(()=>app.close());
 const response=await app.inject({method:'GET',url:endpoint+'/preview'});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().tasks.length,0);
 assert.equal(response.json().questions.length,1);
 assert.equal(response.json().questions[0].id,questionId);
});

test('PO column questions are deleted only with explicit confirmed UUIDs',async t=>{
 const {app,endpoint,getDeleted}=setup();
 t.after(()=>app.close());
 const response=await app.inject({method:'POST',url:endpoint+'/confirm',
  payload:{confirm:true,task_ids:[],question_ids:[questionId]}});
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().deleted_question_ids,[questionId]);
 assert.equal(getDeleted(),1);
});

test('active analyst questions cannot be deleted',async t=>{
 const {app,endpoint,getDeleted}=setup(true);
 t.after(()=>app.close());
 const response=await app.inject({method:'POST',url:endpoint+'/confirm',
  payload:{confirm:true,task_ids:[],question_ids:[questionId]}});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(getDeleted(),0);
});
