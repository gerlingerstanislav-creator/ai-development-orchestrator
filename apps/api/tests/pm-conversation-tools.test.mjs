import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isPmConversationTool,executePmConversationTool}
 from '../dist/modules/planning/infrastructure/pm-conversation-tools.js';

const project=randomUUID(),actor=randomUUID(),task=randomUUID();
const topic=randomUUID(),message=randomUUID(),order=randomUUID();
const manager={project_id:project,actor_id:actor,role:'manager',process_id:message};
const action=(db,name,args={},session=manager)=>executePmConversationTool(db,session,name,args);

test('PM conversation tool router has an explicit, bounded allowlist',()=>{
 for(const name of ['history.search','discussions.list','discussions.read','discussions.open',
  'discussions.close','discussions.reopen','pm.decisions.list','pm.decisions.record',
  'pm.orders.watch_task','pm.orders.list','pm.orders.update']){
  assert.equal(isPmConversationTool(name),true,name);
 }
 for(const name of ['goals.complete','tasks.delete','documents.update','instructions.propose',
  'work.delegate','documentation.request_reset'])assert.equal(isPmConversationTool(name),false,name);
});

test('reading someone else\'s topic does not retrieve its messages',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{calls.push({sql,args});return {rowCount:0,rows:[]};}};
 await assert.rejects(action(db,'discussions.read',{topic_id:topic}),error=>error.statusCode===404);
 assert.equal(calls.length,1);
 assert.match(calls[0].sql,/WHERE id=\$1 AND project_id=\$2/);
 assert.deepEqual(calls[0].args,[topic,project]);
});

test('topic history is project-scoped and returned in chronological reading order',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('FROM project_chat_topics'))return {rows:[{id:topic,title:'Research',status:'open'}],rowCount:1};
  if(sql.includes('FROM assistant_messages'))return {rows:[{body:'Newest'},{body:'Oldest'}],rowCount:2};
  throw Error('Unexpected query '+sql);
 }};
 const result=await action(db,'discussions.read',{topic_id:topic,limit:2});
 assert.deepEqual(result.messages.map(x=>x.body),['Oldest','Newest']);
 assert.match(calls[1].sql,/channel='project' AND status='completed'/);
 assert.deepEqual(calls[1].args,[project,topic,2]);
});

test('opening a duplicate topic preserves its ID and prevents duplicated initial chat messages',async()=>{
 const calls=[];
 const db={query:async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('FROM project_chat_topics')&&sql.includes('status=\'open\''))return {rowCount:1,rows:[{id:topic,title:'Discussion',status:'open'}]};
  return {rowCount:1,rows:[]};
 }};
 const result=await action(db,'discussions.open',{title:'Discussion',opening_message:'First question'});
 assert.equal(result.topic.id,topic);
 assert.equal(result.existing,true);
 assert.equal(calls.filter(x=>x.sql.includes('INSERT INTO project_chat_topics')).length,0);
 const insert=calls.find(x=>x.sql.includes('INSERT INTO assistant_messages'));
 assert.ok(insert);
 assert.match(insert.sql,/WHERE NOT EXISTS/);
 assert.equal(insert.args[3],topic);
});

test('PM decisions require a real owner message in the current project',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{calls.push({sql,args});return {rowCount:0,rows:[]};}};
 await assert.rejects(action(db,'pm.decisions.record',{
  source_message_id:message,question:'Target environment?',answer:'Staging'
 }),error=>error.statusCode===409);
 assert.equal(calls.length,1);
 assert.match(calls[0].sql,/role='user' AND channel='project'/);
 assert.deepEqual(calls[0].args,[message,project]);
});

test('PM decisions are idempotently recorded and do not invent an iteration',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('FROM assistant_messages'))return {rowCount:1,rows:[{id:message,pm_order_id:null}]};
  if(sql.includes('INSERT INTO project_pm_decisions'))return {rowCount:1,rows:[{id:message}]};
  throw Error('Unexpected SQL '+sql);
 }};
 const result=await action(db,'pm.decisions.record',{
  source_message_id:message,question:'How to deploy?',answer:'Deploy only after approval.'
 });
 assert.equal(result.recorded,true);
 assert.equal(result.iteration_id,null);
 assert.equal(result.planning_run_id,undefined);
 const insert=calls.find(x=>x.sql.includes('INSERT INTO project_pm_decisions'));
 assert.match(insert.sql,/ON CONFLICT\(project_id,source_message_id,question\)/);
 assert.deepEqual(insert.args.slice(0,2),[insert.args[0],project]);
});

test('watching a task without a running process never claims Temporal was registered',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('FROM tasks WHERE id=$1'))return {
   rowCount:1,rows:[{id:task,title:'Task',display_number:7,stage:'analysis',analysis_state:'approved',type:'task'}]};
  if(sql.includes('AS active'))return {rowCount:1,rows:[{active:false}]};
  throw Error('Unexpected SQL '+sql);
 }};
 const result=await action(db,'pm.orders.watch_task',{task_id:task});
 assert.equal(result.status,'needs_action');
 assert.equal(result.watch_registered,false);
 assert.ok(!calls.some(x=>x.sql.includes('INSERT INTO project_pm_order_events')));
});

test('only manager in a processing PM inbox can claim a durable task watch',async()=>{
 const db={query:async sql=>{
  if(sql.includes('FROM tasks WHERE id=$1'))return {
   rowCount:1,rows:[{id:task,title:'Task',display_number:7,stage:'development',analysis_state:'approved',type:'task'}]};
  if(sql.includes('AS active'))return {rowCount:1,rows:[{active:true}]};
  if(sql.includes('FROM assistant_messages'))return {rowCount:1,rows:[{id:message}]};
  throw Error('Unexpected query '+sql);
 }};
 await assert.rejects(action(db,'pm.orders.watch_task',{task_id:task},{...manager,role:'analysis'}),error=>error.statusCode===403);
 const watching=await action(db,'pm.orders.watch_task',{task_id:task});
 assert.equal(watching.status,'watching');
 assert.equal(watching.watch_registered,true);
 assert.match(watching.watch_id,/^[a-f0-9-]{36}$/);
 const noInbox=await action({...db,query:async sql=>{
  if(sql.includes('FROM assistant_messages'))return {rowCount:0,rows:[]};
  return db.query(sql);
 }},'pm.orders.watch_task',{task_id:task});
 assert.equal(noInbox.watch_registered,false);
 assert.equal(noInbox.status,'needs_action');
});

test('PM order changes remain project-scoped and append an audit event',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.startsWith('UPDATE project_pm_orders'))return {rowCount:1,rows:[{id:order,status:'waiting_agents'}]};
  if(sql.startsWith('INSERT INTO project_pm_order_events'))return {rowCount:1,rows:[]};
  throw Error('Unexpected SQL '+sql);
 }};
 const result=await action(db,'pm.orders.update',{order_id:order,status:'waiting_agents',summary:'Specialist running'});
 assert.equal(result.status,'waiting_agents');
 assert.deepEqual(calls[0].args.slice(0,2),[project,order]);
 assert.match(calls[1].sql,/INSERT INTO project_pm_order_events/);
 assert.equal(calls[1].args[1],order);
});
