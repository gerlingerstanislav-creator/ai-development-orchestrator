import React from 'react';

export type TaskWorkAssignment={
 id:string;plan_id:string|null;plan_key:string|null;role:string;objective:string;
 acceptance:string;status:string;result:string|null;evidence:string|null;
 prerequisites:Array<{id:string;key:string|null;status:string}>;created_at:string;
};
export type TaskEvidenceRun={
 id:string;source_sha:string;status:'queued'|'dispatching'|'running'|'completed'|'blocked'|'failed'|'cancelled';
 message:string;created_at:string;updated_at:string;
};
export type PmBrowserCaptureRun={
 id:string;source_sha:string|null;status:'running'|'completed'|'blocked';
 message:string;created_at:string;updated_at:string;
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
 assignments,kickoff,evidenceRun,pmCapture,stage,stageLabel,busy,onRetry
}:{
 assignments:TaskWorkAssignment[];kickoff:TaskExecutionKickoff;evidenceRun?:TaskEvidenceRun|null;pmCapture?:PmBrowserCaptureRun|null;
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
 const active=assignments.find(a=>['running','blocked','submitted'].includes(a.status))||assignments.find(a=>a.status==='queued')||assignments.at(-1);
 const lastRun=evidenceRun;
 const runLabel:Record<TaskEvidenceRun['status'],string>={
  queued:'в очереди',dispatching:'запускается',running:'отправлено в Temporal',
  completed:'готово',blocked:'заблокировано',failed:'ошибка',cancelled:'отменено'
 };
 const staleRun=lastRun&&['queued','dispatching','running'].includes(lastRun.status)&&
  Date.now()-new Date(lastRun.updated_at).getTime()>8*60*1000;
 const pmSummary=pmCapture?'Скриншоты ПМ · '+({running:'снимает в Chromium',completed:'готово',blocked:'ошибка'} as const)[pmCapture.status]:null;
 const shortSummary=pmSummary|| (lastRun?'Скриншоты · '+runLabel[lastRun.status]+(staleRun?' · статус без изменений более 8 мин':''):
  active?(roleLabel[active.role]||active.role)+' · '+(statusLabel[active.status]||active.status):
  planning?'ПМ составляет план':'Нет активных поручений');
 return <details className="task-dynamic-plan" aria-label="План выполнения задачи">
  <summary className="task-dynamic-summary">
   <strong>План выполнения</strong>
   <span className="task-dynamic-summary-status" title={shortSummary}>{shortSummary}</span>
   <span className="task-dynamic-expand-hint">Подробнее</span>
  </summary>
  <div className="task-dynamic-expanded">
  <div className="task-dynamic-plan-heading">
   <strong>План выполнения</strong>
   <small>Текущий технический этап: {stageLabel||stage}</small>
  </div>
  {pmCapture&&<div className={'task-evidence-state is-'+pmCapture.status} role="status">
   <strong>ПМ · скриншоты: {pmCapture.status==='completed'?'готово':pmCapture.status==='running'?'снимает в Chromium':'не удалось'}</strong>
   {pmCapture.source_sha&&<small>Ревизия: {pmCapture.source_sha.slice(0,12)}</small>}
   <small>Последнее событие: {new Date(pmCapture.updated_at).toLocaleString('ru-RU')}</small>
   {pmCapture.message&&<p>{pmCapture.message}</p>}
  </div>}
  {lastRun&&<div className={'task-evidence-state is-'+lastRun.status} role="status">
   <strong>Браузерные скриншоты: {runLabel[lastRun.status]}</strong>
   <small>Ревизия: {lastRun.source_sha.slice(0,12)} · Последнее событие: {new Date(lastRun.updated_at).toLocaleString('ru-RU')}</small>
   {lastRun.message&&<p>{lastRun.message}</p>}
   {staleRun&&<small className="task-warning">Статус браузерного запуска не обновлялся больше 8 минут. Это не означает, что процесс остановлен: фактический прогресс смотри в Центре процессов.</small>}
  </div>}
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
  </div>
 </details>;
}
