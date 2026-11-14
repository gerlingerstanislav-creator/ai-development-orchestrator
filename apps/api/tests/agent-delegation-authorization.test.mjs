import test from 'node:test';
import assert from 'node:assert/strict';
import {executeAgentTool} from '../dist/agent-tool-executor.js';

const project='00000000-0000-4000-8000-000000000001';
const task='00000000-0000-4000-8000-000000000002';
const process='00000000-0000-4000-8000-000000000003';

test('active peer specialist can delegate work using agent_peer_queue.note_id',async()=>{
 const statements=[];
 const pool={query:async(sql,args)=>{
  statements.push({sql,args});
  if(sql.includes('FROM agent_work_assignments')&&sql.includes('status=\'running\''))
   return {rowCount:0,rows:[]};
  if(sql.includes('FROM agent_peer_queue'))
   return {rowCount:1,rows:[{id:process}]};
  if(sql.includes('SELECT id,stage,spec_version FROM tasks'))
   return {rowCount:1,rows:[{id:task,stage:'analysis',spec_version:1}]};
  if(sql.includes('count(*)::int AS n'))
   return {rowCount:1,rows:[{n:0}]};
  if(sql.includes('SELECT id,status,granted_tools FROM agent_work_assignments'))
   return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[]};
 }};
 const session={id:process,project_id:project,actor_id:process,task_id:task,
  process_id:process,role:'development',read_only:false};
 const result=await executeAgentTool(pool,session,'work.delegate',{
  task_id:task,role:'testing',
  objective:'Independently inspect current user interface',
  acceptance:'Provide verified browser evidence at the pinned source revision'
 },async()=>{});
 assert.equal(result.status,'queued');
 const auth=statements.find(x=>x.sql.includes('FROM agent_peer_queue'));
 assert.ok(auth);
 assert.match(auth.sql,/SELECT note_id AS id FROM agent_peer_queue/);
 assert.deepEqual(auth.args,[process,project,task,'development']);
 assert.ok(statements.some(x=>x.sql.startsWith('INSERT INTO agent_work_assignments')));
});
