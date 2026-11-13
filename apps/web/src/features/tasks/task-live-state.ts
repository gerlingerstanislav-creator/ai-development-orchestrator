/** Live activity is based on the latest execution, not the Kanban stage or a
 * Temporal workflow lease. Temporal may still own a task while handling a
 * completed/failed QA report, and the project-wide list may lag behind the
 * task-scoped feed.
 */
export type QaExecution={
 id:string;task_id:string;cycle_id:string;status:string;created_at:string;verdict?:string|null
};
export type TaskLease={owner_id:string;state:string}|null;
export type AgentExecution={id:string;kind:string;status:string};

const ongoing=(status:string)=>status==='queued'||status==='running';

/** Human-facing outcome belongs to the finished QA execution, not the stage. */
export function qaOutcomeLabel(run:QaExecution|null):string{
 if(!run)return '';
 if(run.status==='failed')return 'Сбой QA';
 if(run.status!=='completed')return '';
 return run.verdict==='passed'?'Проверено':
  run.verdict==='failed'?'Есть замечания':
  run.verdict==='blocked'?'Ожидает решения':'Завершено';
}

export function latestTaskQa(
 taskId:string,openTaskId:string|null,
 taskRuns:readonly QaExecution[],projectRuns:readonly QaExecution[]
):QaExecution|null{
 // Task-scoped activity is authoritative once loaded. In particular, an
 // older project-wide "running" entry must not revive a failed QA spinner.
 const scoped=openTaskId===taskId?taskRuns.filter(run=>run.task_id===taskId):[];
 const candidates=scoped.length?scoped:projectRuns.filter(run=>run.task_id===taskId);
 return candidates.reduce<QaExecution|null>((latest,run)=>!latest||
  Date.parse(run.created_at)>Date.parse(latest.created_at)||
  (run.created_at===latest.created_at&&run.id>latest.id)?run:latest,null);
}

export function taskQaIsRunning(
 taskId:string,openTaskId:string|null,
 taskRuns:readonly QaExecution[],projectRuns:readonly QaExecution[],
 lease:TaskLease
):boolean{
 const current=latestTaskQa(taskId,openTaskId,taskRuns,projectRuns);
 if(current&&ongoing(current.status))return true;
 // No QA run yet in this cycle: Temporal may still be preparing the test plan.
 // A terminal QA result for the SAME cycle always takes precedence over the
 // lease, which may be released a few seconds later by a Temporal finally.
 return openTaskId===taskId&&!!lease&&lease.state==='active'&&
  (!current||lease.owner_id!==current.cycle_id);
}

export function activeTaskAgentExecutions(
 runs:readonly AgentExecution[],currentQa:QaExecution|null
):AgentExecution[]{
 return runs.filter(run=>ongoing(run.status)&&
  (run.kind!=='testing'||!currentQa||
   (run.id===currentQa.id&&ongoing(currentQa.status))));
}

export function taskHasLiveWork(
 taskId:string,taskStage:string,openTaskId:string|null,
 taskRuns:readonly QaExecution[],projectRuns:readonly QaExecution[],
 lease:TaskLease,agents:readonly AgentExecution[],
 background:readonly {taskId?:string;kind:string;status:string}[],
 developments:readonly {task_id:string;status:string}[],
 processes:readonly {taskId?:string;kind:string;status:string}[]
):boolean{
 const focused=openTaskId===taskId;
 const current=latestTaskQa(taskId,openTaskId,taskRuns,projectRuns);
 const qaWorking=taskQaIsRunning(taskId,openTaskId,taskRuns,projectRuns,focused?lease:null);
 const otherProcesses=background.some(process=>process.taskId===taskId&&ongoing(process.status)&&
   (taskStage!=='testing'||process.kind!=='testing'))||
  processes.some(process=>process.taskId===taskId&&ongoing(process.status)&&
   (taskStage!=='testing'||process.kind!=='testing'));
 if(taskStage==='testing'){
  // The tester's report is terminal even if pollers or Temporal leases lag.
  return qaWorking||otherProcesses||(focused&&activeTaskAgentExecutions(agents,current)
   .some(run=>run.kind!=='testing'));
 }
 return otherProcesses||(focused&&!!lease&&lease.state==='active')||
  developments.some(run=>run.task_id===taskId&&ongoing(run.status))||
  (focused&&activeTaskAgentExecutions(agents,current).length>0);
}
