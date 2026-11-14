import React from 'react';

export type TaskWorkAssignment={
 id:string;plan_id:string|null;plan_key:string|null;role:string;objective:string;
 acceptance:string;status:string;result:string|null;evidence:string|null;
 prerequisites:Array<{id:string;key:string|null;status:string}>;created_at:string;
};
export type TaskExecutionKickoff={
 id:string;pm_order_id:string|null;status:string;pm_dispatch_attempt:number;
}|null;

const statusLabel:Record<string,string>={
 queued:'В очереди',running:'Выполняется',submitted:'Ожидает проверки PM',
 completed:'Принято PM',blocked:'Заблокировано',failed:'Ошибка',
 cancelled:'Отменено'
};
const roleLabel:Record<string,string>={
 analysis:'Аналитик',development:'Разработчик',testing:'QA',
 documentation:'Документация',devops:'DevOps',architect:'Архитектор'
};

export function TaskExecutionPlan({
 assignments,kickoff,stage,stageLabel,busy,onRetry
}:{
 assignments:TaskWorkAssignment[];kickoff:TaskExecutionKickoff;
 stage:string;stageLabel:string;busy:boolean;onRetry:()=>void;
}){
 const plans=new Map<string,TaskWorkAssignment[]>();
 for(const a of assignments){
  const key=a.plan_id||a.id;
  if(!plans.has(key))plans.set(key,[]);
  plans.get(key)!.push(a);
 }
 // Show the latest bounded plan, plus direct delegations not belonging to it.
 const groups=[...plans.values()].slice(-3);
 const planning=kickoff&&['queued','processing'].includes(kickoff.status);
 return <section className="task-dynamic-plan" aria-label="План выполнения задачи">
  <div className="task-dynamic-plan-heading">
   <strong>План выполнения</strong>
   <small>Текущий технический этап: {stageLabel||stage}</small>
  </div>
  {kickoff&&<div className="task-dynamic-kickoff" role="status">
   <span className={'task-plan-dot '+kickoff.status}/>
   <span>{planning?'PM определяет маршрут и доступные инструменты':
    kickoff.status==='failed'?'Планирование PM завершилось ошибкой':
    'Поручение PM создано. Дальнейшие действия и результаты — в истории задачи.'}</span>
   {kickoff.status==='failed'&&<button className="secondary" type="button" disabled={busy} onClick={onRetry}>
    Повторить запуск PM
   </button>}
  </div>}
  {groups.length>0?groups.map((group,index)=><div className="task-dynamic-plan-group" key={group[0].plan_id||group[0].id}>
   {groups.length>1&&<small className="muted">План {index+1} из {groups.length}</small>}
   {group.map(item=><div className={'task-dynamic-step is-'+item.status} key={item.id}>
    <div className="task-dynamic-step-title">
     <span className={'task-plan-dot '+item.status}/>
     <strong>{roleLabel[item.role]||item.role}</strong>
     <small>{statusLabel[item.status]||item.status}</small>
    </div>
    <p>{item.objective}</p>
    {!!item.prerequisites?.length&&<small className="muted">После: {item.prerequisites.map(dep=>
     (dep.key||dep.id.slice(0,8))+' ('+(statusLabel[dep.status]||dep.status)+')').join(', ')}</small>}
    {item.status==='blocked'&&item.result&&<small className="task-warning">{item.result}</small>}
    {item.status==='submitted'&&<small className="muted">Результат получен, но PM ещё не проверил доказательства</small>}
   </div>)}
  </div>):<p className="muted task-dynamic-plan-empty">{planning?'План появится по мере решений PM.':
   kickoff?'Пока нет отдельных поручений; PM может выполнять действие напрямую или назначить исполнителя.':
   'При запуске задачи PM определит необходимые действия. Для текущего технического workflow смотри историю процессов.'}</p>}
 </section>;
}
