/** User-facing Kanban lifecycle is independent from Temporal/workflow stages. */
export const kanbanLanes=[
 {stage:'backlog',label:'Бэклог'},
 {stage:'todo',label:'К работе'},
 {stage:'in_progress',label:'В работе'},
 {stage:'acceptance',label:'На приёмке'},
 {stage:'done',label:'Готово'}
] as const;
export type BoardStatus=typeof kanbanLanes[number]['stage'];
export type KanbanLane={stage:string;label:string};

export type BoardTask={
 id:string;
 display_number:number;
 title:string;
 description:string;
 type:string;
 stage:string;
 board_status?:BoardStatus;
 acceptance_mode?:'undecided'|'manual'|'automatic';
 acceptance_feedback?:string|null;
 postponed_at?:string|null;
 postponed_until?:string|null;
 archived_at?:string|null;
 test_feedback?:string|null;
 created_at:string;
 priority?:number;
 awaits_product_owner?:boolean;
 owner_question_source_task_id?:string|null;
 depends_on_task_id?:string|null;
 pr_url?:string|null;
 git_branch?:string|null;
 document_id?:string|null;
 document_title?:string|null;
 question_status?:'open'|'answered'|'resolved';
};
export function boardLaneFor(task:BoardTask):BoardStatus{
 if(task.postponed_at)return 'backlog';
 if(task.board_status&&kanbanLanes.some(lane=>lane.stage===task.board_status))return task.board_status;
 // Transitional fallback for old API responses, never write it back to stage.
 return task.stage==='backlog'?'backlog':task.stage==='done'?'done':'in_progress';
}
export function attentionNeeded(task:BoardTask){
 return !!task.awaits_product_owner||boardLaneFor(task)==='acceptance'||
  !!task.acceptance_feedback||!!(task.test_feedback&&task.stage==='testing');
}
export function dependencyReady(task:BoardTask,tasks:readonly BoardTask[]){
 if(!task.depends_on_task_id)return true;
 const dep=tasks.find(t=>t.id===task.depends_on_task_id);
 return !!dep&&(['deployment','documentation','done'].includes(dep.stage)||
  (dep.stage==='merge_queue'&&!!dep.pr_url&&!!dep.git_branch));
}
export function kanbanOrder(a:BoardTask,b:BoardTask,tasks:readonly BoardTask[]){
 const blockedA=dependencyReady(a,tasks)&&!a.awaits_product_owner?0:1;
 const blockedB=dependencyReady(b,tasks)&&!b.awaits_product_owner?0:1;
 return blockedA-blockedB||(a.priority??3)-(b.priority??3)||
  new Date(a.created_at).getTime()-new Date(b.created_at).getTime()||
  a.id.localeCompare(b.id);
}
