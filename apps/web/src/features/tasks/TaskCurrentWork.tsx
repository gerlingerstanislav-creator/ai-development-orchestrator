import React from 'react';

export type CurrentWork={
 role:string;status:string;detail:string;source:string;updated_at?:string;
};
const people:Record<string,string>={
 manager:'ПМ',analysis:'Аналитик',analyst:'Аналитик',development:'Разработчик',
 testing:'QA',documentation:'Документация',devops:'DevOps',architect:'Архитектор'
};
const states:Record<string,string>={
 queued:'В очереди',running:'Работает',processing:'Работает',
 submitted:'Проверка результата',blocked:'Заблокирован',waiting:'Ожидает',
 failed:'Ошибка',dispatching:'Запускается'
};
export function describeCurrentWork(work:CurrentWork){
 return (people[work.role]||work.role)+' · '+(states[work.status]||work.status);
}
/** Shows concrete work and owner, not a vague spinning equalizer.
 * All sensitive/long raw logs stay in the Process Center.
 */
export function TaskCurrentWork({items,compact=false}:{
 items?:CurrentWork[];compact?:boolean
}){
 if(!items?.length)return null;
 const shown=items.slice(0,compact?1:2);
 return <div className={'task-current-work'+(compact?' compact':'')} aria-label="Текущая работа по задаче">
  {shown.map((work,index)=><div className="task-current-work-row" key={work.source+'-'+work.role+'-'+index}>
   <span className={'task-current-work-dot '+work.status}/>
   <div className="task-current-work-label">
    <strong>{describeCurrentWork(work)}</strong>
    <span title={work.detail}>{work.detail}</span>
   </div>
  </div>)}
  {items.length>shown.length&&<small>И ещё {items.length-shown.length} поруч.</small>}
 </div>;
}
