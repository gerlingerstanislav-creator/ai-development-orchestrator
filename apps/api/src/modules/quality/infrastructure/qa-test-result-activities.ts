import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {ApplicationFailure} from '@temporalio/common';
import {evaluateQaRun} from '../domain/qa-verdict.js';
import {browserEvidenceAssessment} from '../../../task-evidence.js';
import type {AgentNoteInput} from '../../../task-agent-notes.js';

/** QA result adjudication and blocked-test handoff use the existing Temporal
 * activity names and the existing Runner recovery policy. Dependencies are
 * passed in explicitly; there is no new scheduler, pool or process state.
 */
type QaRunOutcome={status:string;message:string};
export type QaTestResultPorts={
 pool:Pool;
 runner:(path:string)=>Promise<any>;
 trackRunnerWait:(kind:'testing',projectId:string,id:string,error?:unknown,recoveryDetail?:string)=>Promise<QaRunOutcome>;
 failRunnerRun:(kind:'testing',projectId:string,id:string,message:string)=>Promise<QaRunOutcome>;
 startTesting:(args:{projectId:string;taskId:string;cycleId:string;attempt:number;recovery:true;simplified:boolean})=>Promise<string>;
 recordLearning:(input:{projectId:string;role:string;runId:string;body:unknown;evidence:string})=>Promise<void>;
 recordNote:(input:AgentNoteInput)=>Promise<boolean>;
 syncManagerInbox:(projectId:string,taskId:string)=>Promise<unknown>;
 event:(projectId:string,processId:string,kind:string,stage:string,detail:string,level?:string)=>Promise<void>;
};
export function createQaTestResultActivities(ports:QaTestResultPorts){
 const {pool,runner,trackRunnerWait,failRunnerRun,startTesting,recordLearning,
  recordNote,syncManagerInbox,event}=ports;
async function checkTesting(args:{projectId:string;taskId:string;testId:string}):Promise<{status:string;message:string;verdict?:string}>{
 const {projectId,testId}=args;
 const row=await pool.query('SELECT status,message,task_id,cycle_id,attempt,qa_spec_version,qa_plan_snapshot FROM ai_test_runs WHERE id=$1 AND project_id=$2',[testId,projectId]);
 if(!row.rowCount)throw ApplicationFailure.nonRetryable('Запуск тестирования не найден');
 if(row.rows[0].status==='cancelled')return {status:'failed',message:'Прервано пользователем'};
 if(['completed','failed'].includes(row.rows[0].status)){
  const old=await pool.query('SELECT verdict FROM ai_test_runs WHERE id=$1',[testId]);
  return {status:row.rows[0].status,message:row.rows[0].message,verdict:old.rows[0]?.verdict};
 }
 let remote;
 try{remote=await runner('/jobs/'+testId);}
 catch(error){
  if((error as {statusCode?:number}).statusCode!==404)return trackRunnerWait('testing',projectId,testId,error);
  remote={status:'interrupted'};
 }
 if(remote.status==='cancelled')return failRunnerRun('testing',projectId,testId,'Исполнитель подтвердил остановку тестирования');
 if(remote.status==='interrupted'){
  const test=row.rows[0];
  if(!test.cycle_id)return failRunnerRun('testing',projectId,testId,'У старого QA-прогона отсутствует идентификатор цикла');
  try{await startTesting({projectId,taskId:test.task_id,cycleId:test.cycle_id,attempt:test.attempt,recovery:true,simplified:test.qa_plan_snapshot?.simplified===true});}
  catch(error){
   if(error instanceof ApplicationFailure&&error.nonRetryable)return failRunnerRun('testing',projectId,testId,error.message);
   return trackRunnerWait('testing',projectId,testId,error);
  }
  return trackRunnerWait('testing',projectId,testId,undefined,remote.message);
 }
 const status=String(remote.status||'running'),message=String(remote.message||'').slice(0,2500);
 if(status==='completed'||status==='failed'){
   if(status==='completed')await recordLearning({projectId,role:'testing',runId:testId,body:remote.learningSuggestion,evidence:'QA-прогон '+testId+'; вердикт '+String(remote.verdict||'')});
  const snapshot=row.rows[0].qa_plan_snapshot;
  const singlePass=snapshot?.singlePass===true;
  if(singlePass&&status==='completed'&&remote.executionVerified!==true)
   return failRunnerRun('testing',projectId,testId,'Runner не подтвердил исполнение проверок. Обновите Codex Runner и повторите QA.');
  const currentSpec=await pool.query('SELECT spec_version,spec_review_status,spec_reviewed_version,spec_reviewed_commit,execution_mode,evidence_source_sha FROM tasks WHERE id=$1 AND project_id=$2',[row.rows[0].task_id,projectId]);
  const assessed=evaluateQaRun({
   snapshot,remote,status,message,qaSpecVersion:row.rows[0].qa_spec_version,currentSpec
  });
  const {adHoc,cases,checked,outcome,report}=assessed;
  let verdict=assessed.verdict;
  if(currentSpec.rows[0]?.execution_mode==='browser_evidence'&&verdict==='passed'){
   const proof=browserEvidenceAssessment(report,String(currentSpec.rows[0].evidence_source_sha||''));
   if(!proof.passed){
    verdict='blocked';
    report.summary=String(report.summary||'').slice(0,1200)+' · Артефакты не подтверждены: '+proof.reason;
   }
  }
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const locked=await client.query("SELECT id FROM ai_test_runs WHERE id=$1 AND status IN ('queued','running') FOR UPDATE",[testId]);
   if(!locked.rowCount){
    await client.query('ROLLBACK');
    return {status:'failed',message:'QA-прогон уже завершён или отменён'};
   }
   for(const check of adHoc?[]:checked){
    await client.query('INSERT INTO qa_case_results(id,project_id,test_run_id,case_id,result,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(test_run_id,case_id) DO UPDATE SET result=EXCLUDED.result,evidence=EXCLUDED.evidence',
     [randomUUID(),projectId,testId,check.case_id,check.result,check.evidence]);
   }
   await client.query('UPDATE ai_test_runs SET status=$2,message=$3,verdict=$4,report=$5,qa_plan_snapshot=COALESCE($6,qa_plan_snapshot),completed_at=now() WHERE id=$1',
    [testId,status,outcome,verdict,JSON.stringify(report),adHoc?JSON.stringify({...snapshot,cases}):null]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  if(String(remote.handoffNote||'').trim())await recordNote({projectId,taskId:row.rows[0].task_id,authorStage:'testing',authorName:'AI-тестировщик',targetStage:verdict==='failed'?'development':'all',kind:verdict==='failed'?'risk':'handoff',body:String(remote.handoffNote),sourceKey:'tester:'+testId,sourceRunId:testId});
  await event(projectId,testId,'testing',verdict,String(report.summary||'Тестирование завершено').slice(0,1400)+' · Результаты всех тест-кейсов доступны в отчёте QA в чате задачи.',verdict==='passed'?'info':verdict==='failed'?'error':'warning');
  return {status,message:outcome,verdict};
 }
 if(message!==row.rows[0].message){
  await pool.query("UPDATE ai_test_runs SET status=$2,message=$3 WHERE id=$1 AND status IN ('queued','running')",[testId,status,message]);
  await event(projectId,testId,'testing','progress',message);
 }
 return {status,message};
}
/** Tool limitations are not defects; retain the tested code for human review. */
async function noteBlockedTests(args:{projectId:string;taskId:string;testId:string;simplified?:boolean}):Promise<void>{
 const {projectId,taskId,testId}=args;
 const test=await pool.query('SELECT status,verdict,report,qa_plan_snapshot FROM ai_test_runs WHERE id=$1 AND project_id=$2 AND task_id=$3',[testId,projectId,taskId]);
 if(!test.rowCount||test.rows[0].status!=='completed'||test.rows[0].verdict!=='blocked')
  throw ApplicationFailure.nonRetryable('Нельзя согласовать не завершённый или не заблокированный QA-прогон');
 const cases=Array.isArray(test.rows[0].report?.caseResults)?test.rows[0].report.caseResults:[];
 const missing=cases.filter((c:any)=>['blocked','not_run'].includes(c.result));
 const planned=Array.isArray(test.rows[0].qa_plan_snapshot?.cases)?test.rows[0].qa_plan_snapshot.cases:[];
 const names=new Map<string,string>(planned.map((c:{id:string;title:string})=>[c.id,c.title]));
 const ran=cases.filter((c:any)=>['passed','failed'].includes(c.result)).length;
 const reasons:Record<string,string>={tool_unavailable:'нет нужного инструмента',environment_unavailable:'нет подходящей среды',manual_only:'нужна ручная проверка'};
 const summary=String(test.rows[0].report?.summary||'').slice(0,450);
 const stale=test.rows[0].report?.staleSpecification===true?' Во время проверки изменилось ТЗ или PR. Нужна повторная проверка.':'';
 const msg=('Проверено '+ran+' из '+planned.length+'. Не удалось проверить '+missing.length+'. '+
  missing.slice(0,3).map((c:any)=>(names.get(c.case_id)||'Сценарий')+' — '+(reasons[c.reason]||'результат не подтверждён')).join('; ')+
  (missing.length>3?' и ещё '+(missing.length-3)+'.':'')+(summary?' '+summary:'')+stale).slice(0,1200);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const updated=await client.query("UPDATE tasks SET stage=$4,test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing' AND test_feedback IS DISTINCT FROM $3 RETURNING id",
   [taskId,projectId,msg,'testing']);
  if(updated.rowCount){
   await client.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',[randomUUID(),taskId,'qa_tools_unavailable',msg]);
   await client.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level) VALUES($1,$2,$3,'testing',$4,$5,'warning')",
    [randomUUID(),projectId,testId,'awaiting_manual_qa_decision',msg]);
  }
  await client.query('COMMIT');
  if(!updated.rowCount)return;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 if(!args.simplified)await syncManagerInbox(projectId,taskId);
}
 return {checkTesting,noteBlockedTests};
}
