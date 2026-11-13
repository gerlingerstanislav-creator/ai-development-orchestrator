/**
 * A work plan is a graph of intended deliverables, not a fixed Kanban route.
 * Pure validation is shared by the planning API and regression tests.
 */
export type WorkPlanStep={
 key:string;
 role:string;
 objective:string;
 acceptance:string;
 needs:readonly string[];
};

export function orderWorkPlan(steps:readonly WorkPlanStep[]):WorkPlanStep[]{
 if(!steps.length||steps.length>12)throw Error('План должен содержать от 1 до 12 поручений');
 const byKey=new Map<string,WorkPlanStep>();
 for(const step of steps){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(step.key))throw Error('Неверный ключ поручения');
  if(byKey.has(step.key))throw Error('Повторяется ключ поручения: '+step.key);
  if(step.needs.length>8||new Set(step.needs).size!==step.needs.length)
   throw Error('Некорректные зависимости поручения: '+step.key);
  byKey.set(step.key,step);
 }
 const states=new Map<string,0|1|2>();
 const result:WorkPlanStep[]=[];
 function visit(key:string){
  const state=states.get(key)||0;
  if(state===2)return;
  if(state===1)throw Error('Циклическая зависимость поручений: '+key);
  const step=byKey.get(key);
  if(!step)throw Error('Неизвестная зависимость: '+key);
  states.set(key,1);
  for(const needed of step.needs){
   if(needed===key)throw Error('Поручение не может зависеть от самого себя: '+key);
   visit(needed);
  }
  states.set(key,2);
  result.push(step);
 }
 for(const step of steps)visit(step.key);
 return result;
}
