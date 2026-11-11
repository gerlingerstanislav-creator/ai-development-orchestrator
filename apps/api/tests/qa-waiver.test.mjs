import test from 'node:test';
import assert from 'node:assert/strict';
import {qaWaiverAssessment,latestQaWaiver} from '../dist/qa-waiver.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

const sha='c'.repeat(40);
const base=()=>({
 id:'00000000-0000-4000-8000-000000000007',
 task_id:'00000000-0000-4000-8000-000000000008',
 status:'completed',verdict:'blocked',qa_spec_version:3,
 qa_plan_snapshot:{cases:[
  {id:'a',title:'API responds with correct payload',priority:'high'},
  {id:'b',title:'User can navigate visually',priority:'normal'}
 ]},
 report:{commit:sha,summary:'API verified, browser is unavailable',findings:[],
  checks:[{name:'API contract',result:'passed',details:'curl and assertions succeeded'}],
  caseResults:[
   {case_id:'a',result:'passed',reason:'executed',evidence:'HTTP 200 and payload were verified'},
   {case_id:'b',result:'blocked',reason:'tool_unavailable',evidence:'Chromium and Playwright are not installed in QA container'}
  ]}
});
test('allows a documented tooling gap, never considers it a passing test',()=>{
 const r=qaWaiverAssessment(base());
 assert.equal(r.eligible,true);
 assert.equal(r.passed,1);
 assert.equal(r.unverified.length,1);
 assert.equal(r.unverified[0].title,'User can navigate visually');
});
test('rejects reported regressions, test failures and confirmed findings',()=>{
 const a=base();a.report.caseResults[0].result='failed';assert.equal(qaWaiverAssessment(a).eligible,false);
 const b=base();b.report.checks[0].result='failed';assert.equal(qaWaiverAssessment(b).eligible,false);
 const c=base();c.report.findings=[{severity:'major',description:'Broken response'}];assert.equal(qaWaiverAssessment(c).eligible,false);
});
test('rejects unknown, undocumented or merely skipped scenarios',()=>{
 const a=base();a.report.caseResults[1].reason='unknown';assert.equal(qaWaiverAssessment(a).eligible,false);
 const b=base();b.report.caseResults[1].evidence='Cannot';assert.equal(qaWaiverAssessment(b).eligible,false);
 const c=base();c.report.caseResults[1].result='passed';assert.equal(qaWaiverAssessment(c).eligible,false);
 const d=base();d.report.caseResults.pop();assert.equal(qaWaiverAssessment(d).eligible,false);
});
test('requires completed blocked run with tested commit, spec version and plan',()=>{
 const a=base();a.status='failed';assert.equal(qaWaiverAssessment(a).eligible,false);
 const b=base();b.verdict='failed';assert.equal(qaWaiverAssessment(b).eligible,false);
 const c=base();c.report.commit='';assert.equal(qaWaiverAssessment(c).eligible,false);
 const d=base();d.qa_spec_version=null;assert.equal(qaWaiverAssessment(d).eligible,false);
 const e=base();e.qa_plan_snapshot.cases=[];assert.equal(qaWaiverAssessment(e).eligible,false);
});

test('waiver approval is scoped to the latest QA run, not an older run for the same task',async t=>{
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});
 await client.connect();
 const schema='qawaiver_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await client.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await client.end();});
 await client.query('CREATE SCHEMA '+schema);
 await client.query('SET search_path TO '+schema+',public');
 await client.query(`
  CREATE TABLE ai_test_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid,status text,verdict text,qa_spec_version int,qa_plan_snapshot jsonb,report jsonb,created_at timestamptz);
  CREATE TABLE qa_merge_waivers(id uuid PRIMARY KEY,project_id uuid,task_id uuid,test_run_id uuid,justification text,commit_sha text,spec_version int,approved_by uuid,unverified_cases jsonb,created_at timestamptz);
 `);
 const project=randomUUID(),task=randomUUID(),oldRun=randomUUID(),newRun=randomUUID();
 const make=async(id,seconds)=>client.query(
  "INSERT INTO ai_test_runs(id,project_id,task_id,status,verdict,qa_spec_version,qa_plan_snapshot,report,created_at) VALUES($1,$2,$3,'completed','blocked',3,$4::jsonb,$5::jsonb,now()+$6::int * interval '1 second')",
  [id,project,task,JSON.stringify(base().qa_plan_snapshot),JSON.stringify(base().report),seconds]);
 await make(oldRun,0);
 await client.query(
  "INSERT INTO qa_merge_waivers(id,project_id,task_id,test_run_id,justification,commit_sha,spec_version,approved_by,unverified_cases,created_at) VALUES($1,$2,$3,$4,'Owner accepted risk',$5,3,$6,'[]'::jsonb,now())",
  [randomUUID(),project,task,oldRun,sha,randomUUID()]);
 assert.ok((await latestQaWaiver(pool,project,task)).approval,'original exception remains visible for its run');
 await make(newRun,5);
 const latest=await latestQaWaiver(pool,project,task);
 assert.equal(latest.run_id,newRun);
 assert.equal(latest.approval,null,'old risk acceptance must not apply to a newer QA run');
 assert.equal(latest.assessment.eligible,true);
});
