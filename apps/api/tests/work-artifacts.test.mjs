import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateWorkArtifact,storeWorkArtifact,listWorkArtifacts,installWorkArtifactsSchema,installGoalWorkArtifactScope}
 from '../dist/modules/agents/infrastructure/work-artifacts.js';

const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const assignmentId='00000000-0000-4000-8000-000000000003';
const sourceSha='a'.repeat(40);
const bytes=Buffer.concat([Buffer.from([255,216]),Buffer.alloc(104,65),Buffer.from([255,217])]);
const sha256=createHash('sha256').update(bytes).digest('hex');
const input={projectId,taskId,assignmentId,sourceSha,sha256,
 name:'390x844-00000000-0000-4000-8000-000000000004.jpg',
 mime:'image/jpeg',viewport:{width:390,height:844},
 origin:'isolated-local-browser',data:bytes.toString('base64')};

test('screenshot evidence requires real bytes matching a cryptographic receipt',()=>{
 assert.deepEqual(validateWorkArtifact(input),bytes);
 assert.throws(()=>validateWorkArtifact({...input,sha256:'0'.repeat(64)}),/SHA256/);
 assert.throws(()=>validateWorkArtifact({...input,origin:'model-response'}),/не является доверенной/);
 assert.throws(()=>validateWorkArtifact({...input,data:Buffer.from('fake').toString('base64')}),/JPEG/);
});

test('artifact storage enforces active assignment and bounded cross-project scope',async()=>{
 const calls=[];
 const pool={query:async(sql,args)=>{
  calls.push({sql,args});
  return {rowCount:1,rows:[{id:'00000000-0000-4000-8000-000000000005'}]};
 }};
 await storeWorkArtifact(pool,input);
 assert.match(calls[0].sql,/LEFT JOIN tasks t ON t.id=a.task_id/);
 assert.match(calls[0].sql,/a.status IN \('running','submitted'\)/);
 assert.match(calls[0].sql,/t.spec_version=a.spec_version/);
 assert.deepEqual(calls[0].args.slice(1,5),[projectId,taskId,null,assignmentId]);
 assert.ok(Buffer.isBuffer(calls[0].args.at(-1)));
});

test('work artifacts are linkable only within the same project and task',async()=>{
 const queries=[];
 const db={query:async(sql,args)=>{queries.push(args);return {
  rowCount:1,rows:[{id:'00000000-0000-4000-8000-000000000005',sha256}]
 };}};
 const result=await listWorkArtifacts(db,projectId,taskId);
 assert.deepEqual(queries[0],[projectId,taskId]);
 assert.equal(result.artifacts[0].url,
  '/api/projects/'+projectId+'/tasks/'+taskId+'/work-artifacts/00000000-0000-4000-8000-000000000005');
});

test('artifact migration is additive and persisted evidence is immutable',async()=>{
 const queries=[];
 await installWorkArtifactsSchema({query:async sql=>{queries.push(sql);return {rowCount:0,rows:[]};}});
 assert.match(queries[0],/CREATE TABLE IF NOT EXISTS agent_work_artifacts/);
 assert.match(queries[0],/UNIQUE\(assignment_id,sha256\)/);
 assert.doesNotMatch(queries[0],/DROP TABLE|DELETE FROM/);
});

test('v20 goal evidence scope is additive and references the same project',async()=>{
 const calls=[];
 await installGoalWorkArtifactScope({query:async sql=>{calls.push(sql);return {rows:[],rowCount:0};}});
 const sql=calls.join('\n');
 assert.match(sql,/ALTER TABLE agent_work_artifacts ALTER COLUMN task_id DROP NOT NULL/);
 assert.match(sql,/agent_work_artifact_scope_xor CHECK/);
 assert.match(sql,/agent_work_artifact_goal_project FOREIGN KEY\(project_id,goal_id\)/);
 assert.match(sql,/CREATE INDEX IF NOT EXISTS idx_agent_work_artifacts_goal/);
 assert.doesNotMatch(sql,/TRUNCATE|DROP TABLE|DELETE FROM/);
});

test('goal-only screenshot uses the same signed JPEG receipt and assignment scope',async()=>{
 const goalId='00000000-0000-4000-8000-000000000006';
 const statements=[];
 const db={query:async(sql,args)=>{
  statements.push({sql,args});return {rowCount:1,rows:[{id:'00000000-0000-4000-8000-000000000007'}]};
 }};
 const goalInput={...input,taskId:null,goalId};
 const saved=await storeWorkArtifact(db,goalInput);
 assert.equal(saved.duplicate,false);
 assert.match(statements[0].sql,/a.goal_id IS NOT DISTINCT FROM \$4::uuid/);
 assert.match(statements[0].sql,/g.status<>'completed'/);
 assert.deepEqual(statements[0].args.slice(1,5),[projectId,null,goalId,assignmentId]);
 await assert.rejects(storeWorkArtifact(db,{...input,goalId}),/ровно одну/);
 await assert.rejects(storeWorkArtifact(db,{...input,taskId:null,goalId:null}),/ровно одну/);
 const listed=await listWorkArtifacts(db,projectId,null,goalId);
 assert.deepEqual(statements.at(-1).args,[projectId,goalId]);
 assert.equal(listed.artifacts[0].url,
  '/api/projects/'+projectId+'/goals/'+goalId+'/work-artifacts/00000000-0000-4000-8000-000000000007');
});
