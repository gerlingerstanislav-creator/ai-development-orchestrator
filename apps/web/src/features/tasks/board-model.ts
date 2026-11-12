/** Kanban view policy is pure: no React state, network, or browser globals. */
export type KanbanGroupKey='analytics'|'development'|'testing'|'merging'|'results'|'other';
export type KanbanLane={stage:string;label:string};
export type KanbanGroup={key:KanbanGroupKey;title:string;stages:KanbanLane[]};

export type BoardTask={
 id:string;
 display_number:number;
 title:string;
 description:string;
 type:string;
 stage:string;
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
const stageGroupDefinitions:{key:KanbanGroupKey;title:string;ids:string[]}[]=[
 {key:'analytics',title:'Аналитика',ids:['backlog','analysis']},
 {key:'development',title:'Разработка',ids:['development','testing','merge_queue']},
 {key:'results',title:'Итоги',ids:['deployment','documentation','done']}
];
export function groupKanbanStages(stages:readonly KanbanLane[]):KanbanGroup[]{
 const groups=stageGroupDefinitions.map(def=>({
  key:def.key,title:def.title,
  stages:stages.filter(stage=>def.ids.includes(stage.stage))
 })).filter(group=>group.stages.length>0);
 const others=stages.filter(stage=>!stageGroupDefinitions.some(group=>group.ids.includes(stage.stage)));
 if(others.length)groups.push({key:'other',title:'Другие этапы',stages:others});
 return groups;
}
export function boardLaneFor(task:BoardTask){return task.stage;}
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
