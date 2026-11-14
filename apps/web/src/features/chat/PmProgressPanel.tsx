import React from 'react';
import {CheckCircle2,ChevronDown,LoaderCircle} from 'lucide-react';

export type PmProgressEvent={
 id:string;message_id:string;attempt:number;kind:'status'|'summary'|'plan'|'tool'|'message';text:string;created_at:string;
};
export function PmProgressPanel({events,status}:{events:PmProgressEvent[];status?:string}){
 const running=status==='processing';
 const waiting=status==='queued';
 if(!events.length&&!running&&!waiting)return null;
 const visible=events.filter(event=>event.kind!=='message').slice(-25);
 const liveMessage=running?[...events].reverse().find(event=>event.kind==='message'):undefined;
 return <details className={'pm-progress '+(running?'pm-progress-active':'')} open={running||undefined}>
  <summary className="pm-progress-heading">
   {running?<LoaderCircle size={15} className="pm-progress-spinner" />:
    <CheckCircle2 size={15}/>}
   <span>{running?'ПМ работает · ход работы':waiting?'ПМ ожидает очереди':'Ход работы ПМ'}</span>
   <small>{events.length?events.length+' событий':''}</small>
   <ChevronDown size={14} className="pm-progress-chevron"/>
  </summary>
  <div className="pm-progress-timeline">
   {liveMessage&&<div className="pm-progress-entry pm-progress-live-answer" key={liveMessage.id}>
    <span className="pm-progress-dot pm-progress-summary"/>
    <div><small>Ответ ПМ · печатается</small><p>{liveMessage.text}</p></div>
   </div>}
   {visible.length?visible.map(event=><div className="pm-progress-entry" key={event.id}>
    <span className={'pm-progress-dot pm-progress-'+event.kind}/>
    <div>
     <small>{event.kind==='summary'?'Сводка':event.kind==='tool'?'Инструмент':
      event.kind==='plan'?'План':'Статус'}{event.attempt>1?' · попытка '+event.attempt:''}</small>
     <p>{event.text}</p>
    </div>
   </div>):!liveMessage&&<p className="pm-progress-empty">Сообщение в очереди. История появится после запуска.</p>}
  </div>
 </details>;
}
