/** Pure, independently testable iteration plan rules. No PostgreSQL or Fastify. */
export type IterationWork={
 key:string;title:string;description:string;kind:'analysis'|'development';
 tags:string[];depends_on?:string;document_ids?:string[];
};
export type IterationPlanShape={
 epics:Array<{key:string;title:string;description:string;tasks:IterationWork[]}>;
};
export type TaskPlanRow={id:string;project_id:string;title:string;description:string;type:string;stage:string;parent_id:string|null;iteration_item_key:string|null;depends_on_task_id:string|null;iteration_work_kind:string|null;tags:string[];spec_version:number;updated_at:string};
function planProblem(statusCode:number,message:string){return Object.assign(Error(message),{statusCode});}
export function validatePlan(plan:IterationPlanShape){
 const keys=new Set<string>();
 const known=new Map<string,IterationWork>();
 const total=plan.epics.reduce((count,epic)=>count+epic.tasks.length,0);
 if(total>80)throw planProblem(400,'В одном плане допускается до 80 задач');
 const unique=(item:{key:string})=>{
  if(keys.has(item.key))throw planProblem(400,'Ключи эпиков и задач должны быть уникальны');
  keys.add(item.key);
 };
 for(const epic of plan.epics){
  unique(epic);
  for(const task of epic.tasks){unique(task);known.set(task.key,task);}
 }
 for(const task of known.values()){
  const visited=new Set([task.key]);
  let dependency=task.depends_on;
  while(dependency){
   const parent=known.get(dependency);
   if(!parent||visited.has(dependency))throw planProblem(400,'В плане есть неизвестная или циклическая зависимость');
   visited.add(dependency);
   dependency=parent.depends_on;
  }
 }
}

export const normalizeIterationName=(name:string)=>name.trim().toLowerCase();
export function planDiff(items:ReturnType<typeof planItems>['items']){
 const known=new Map(items.filter(i=>i.existing).map(i=>[i.key,i.existing!.id]));
 return items.map(item=>{
  const old=item.existing;
  if(!old)return {...item,changes:[] as string[]};
  const changes:string[]=[];
  const check=(field:string,a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))changes.push(field);};
  check('title',old.title,item.title);check('description',old.description,item.description);
  if(item.parent){
   check('tags',[...(old.tags||[])].sort(),[...(item.tags||[])].sort());
   check('kind',old.iteration_work_kind,item.kind??null);
   check('parent',old.parent_id,known.get(item.parent)??null);
   check('depends_on',old.depends_on_task_id,item.depends_on?known.get(item.depends_on)??null:null);
  }
  return {...item,changes};
 });
}
export function planItems(plan:IterationPlanShape,current:TaskPlanRow[]){
 const items:{key:string;title:string;description:string;kind?:'analysis'|'development';tags?:string[];depends_on?:string;document_ids?:string[];parent?:string;existing?:TaskPlanRow}[]=[];
 const clarifications:{epicKey:string;key:string;title:string;description:string}[]=[];
 const claimed=new Set<string>();
 function find(item:{key:string;title:string},epic:boolean,parentId:string|null,hasParent:boolean){
  const match=current.find(task=>task.iteration_item_key===item.key&&(task.type==='epic')===epic)||
   (hasParent?current.find(task=>task.parent_id===parentId&&(task.type==='epic')===epic&&normalizeIterationName(task.title)===normalizeIterationName(item.title)):undefined);
  if(match&&claimed.has(match.id))throw planProblem(409,'Две позиции плана совпадают с одной существующей задачей. Уточни план.');
  if(match)claimed.add(match.id);
  return match;
 }
 for(const epic of plan.epics){
  const existing=find(epic,true,null,true);
  items.push({key:epic.key,title:epic.title,description:epic.description,existing});
  for(const task of epic.tasks){
   // Old saved plans may still contain analysis-only cards. Convert them to
   // questions on the corresponding implementation task, never new tasks.
   if(task.kind==='analysis'){
    clarifications.push({epicKey:epic.key,key:task.key,title:task.title,description:task.description});
    continue;
   }
   // A dependency on an old clarification-only card is now satisfied
   // inside this task's own analysis. It must not point to a missing task ID.
   const clarificationDependency=epic.tasks.some(other=>other.kind==='analysis'&&other.key===task.depends_on);
   items.push({...task,depends_on:clarificationDependency?undefined:task.depends_on,
    parent:epic.key,existing:find(task,false,existing?.id??null,!!existing)});
  }
 }
 return {items,clarifications,unmentioned:current.filter(task=>!claimed.has(task.id)).map(({id,title})=>({id,title}))};
}

