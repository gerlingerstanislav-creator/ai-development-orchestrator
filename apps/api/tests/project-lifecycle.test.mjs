import test from 'node:test';
import assert from 'node:assert/strict';
import {projectDeletionConfirmation,findActiveProjectOperation,activeProjectOperationChecks} from '../dist/project-lifecycle.js';

test('permanent deletion requires exact project name, not substring or trimmed input',()=>{
 assert.equal(projectDeletionConfirmation('Alpha', 'Alpha'),true);
 assert.equal(projectDeletionConfirmation('Alpha', 'alpha'),false);
 assert.equal(projectDeletionConfirmation('Alpha', ' Alpha '),false);
 assert.equal(projectDeletionConfirmation('Alpha', 'Alph'),false);
 assert.equal(projectDeletionConfirmation('', ''),false);
});

test('active operations block project trash and purge',async()=>{
 const calls=[];
 const db={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:sql.includes('task_orchestration_owners')?1:0};}};
 const check=await findActiveProjectOperation(db,'project-id');
 assert.ok(check>0);
 assert.ok(calls.some(x=>x.sql.includes('task_orchestration_owners')));
 assert.ok(calls.every(x=>x.params[0]==='project-id'));
});

test('finished operations do not block project deletion',async()=>{
 const db={query:async()=>({rowCount:0})};
 assert.equal(await findActiveProjectOperation(db,'project-id'),0);
 assert.ok(activeProjectOperationChecks.length>=6);
 assert.ok(activeProjectOperationChecks.some(s=>s.includes('agent_sessions')));
 assert.ok(activeProjectOperationChecks.some(s=>s.includes('document_import_jobs')));
});
