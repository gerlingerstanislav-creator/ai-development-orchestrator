import test from 'node:test';
import assert from 'node:assert/strict';
import {
 readProjectAgentAvailability,ProjectAgentAvailabilityError
} from '../dist/modules/execution/project-agent-availability.js';

const scopes=[
 [{projectId:'project'},'FROM projects WHERE id=$1'],
 [{runId:'analysis',kind:'analysis'},'FROM agent_analysis_runs r'],
 [{runId:'note',kind:'peer'},'FROM agent_peer_queue r'],
 [{runId:'plan',kind:'planning'},'FROM iteration_planning_runs r'],
 [{runId:'import',kind:'documentation'},'FROM document_import_jobs r']
];

test('project agent pause gate resolves every supported process through scoped SQL',async()=>{
 for(const [scope,expectedSql] of scopes){
  const queries=[];
  const db={query:async(sql,args)=>{queries.push({sql,args});return {rowCount:1,rows:[{agents_running:true}]}}};
  assert.equal(await readProjectAgentAvailability(db,scope),true);
  assert.equal(queries.length,1);
  assert.ok(queries[0].sql.includes(expectedSql));
  assert.deepEqual(queries[0].args,[scope.projectId??scope.runId]);
 }
});

test('pause gate reports paused project rather than a missing process',async()=>{
 const db={query:async()=>({rowCount:1,rows:[{agents_running:false}]})};
 assert.equal(await readProjectAgentAvailability(db,{projectId:'paused'}),false);
});

test('unknown scope, unsupported process, and deleted project fail distinctly',async()=>{
 const db={query:async()=>({rowCount:0,rows:[]})};
 for(const [scope,pattern] of [
  [{},/Не задан проект/],
  [{runId:'run'},/Неизвестный тип/],
  [{projectId:'deleted'},/удалён/]
 ]){
  await assert.rejects(readProjectAgentAvailability(db,scope),
   error=>error instanceof ProjectAgentAvailabilityError&&pattern.test(error.message));
 }
});
