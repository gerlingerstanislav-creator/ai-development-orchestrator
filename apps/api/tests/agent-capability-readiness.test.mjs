import test from 'node:test';
import assert from 'node:assert/strict';
import {readAgentCapabilityReadiness}
 from '../dist/modules/agents/infrastructure/agent-capability-readiness.js';

function mock(row,capacity=1){
 const statements=[];
 const db={query:async(sql,args)=>{
  statements.push({sql,args});
  if(sql.includes('FROM projects p WHERE'))return {rowCount:row?1:0,rows:row?[row]:[]};
  if(sql.includes('SELECT capacity FROM project_role_capacity'))
   return {rowCount:1,rows:[{capacity}]};
  throw Error('Unexpected database lookup');
 }};
 return {db,statements};
}
test('capacity and configured source are reported as observable facts, not browser success',async()=>{
 const {db,statements}=mock({
  agents_running:true,github_configured:true,
  running_assignments:1,queued_assignments:2,running_consultations:0
 },2);
 const state=await readAgentCapabilityReadiness(db,'project','testing');
 assert.equal(state.agents_enabled,true);
 assert.equal(state.github_configured,true);
 assert.equal(state.running_assignments,1);
 assert.equal(state.queued_assignments,2);
 assert.equal(state.dispatch_slots,1);
 assert.equal(state.scheduling_capacity_available,true);
 assert.equal(state.environment.project_source,'configured_not_verified');
 assert.equal(state.environment.isolated_browser,'unverified_until_runtime_probe');
 assert.ok(statements.some(x=>x.sql.includes("a.role=$2")&&x.args[1]==='testing'));
 assert.ok(!JSON.stringify(state).includes('secret_encrypted'));
});
test('paused project, missing GitHub and full role capacity must not look ready',async()=>{
 const {db}=mock({
  agents_running:false,github_configured:false,
  running_assignments:1,queued_assignments:3,running_consultations:1
 },2);
 const result=await readAgentCapabilityReadiness(db,'project','testing');
 assert.equal(result.scheduling_capacity_available,false);
 assert.equal(result.dispatch_slots,0);
 assert.equal(result.environment.project_source,'not_configured');
 assert.ok(result.limitations.some(x=>x.includes('остановлены')));
 assert.ok(result.limitations.some(x=>x.includes('занята')));
});
test('a different or deleted project never exposes availability',async()=>{
 const {db}=mock(null);
 await assert.rejects(readAgentCapabilityReadiness(db,'other-project','testing'),/Проект недоступен/);
});
