/** Pure process-center display model; no API or component state dependencies. */
export type ProjectProcess={id:string;iterationId?:string;kind:'document_import'|'development'|'merge'|'testing'|'analysis'|'ci'|'review';title:string;status:string;detail:string;createdAt:string;updatedAt?:string|null;sourceUrl?:string|null;requestText?:string|null;sourceFileCount?:number|null;savedDocuments?:number;hasDraft?:boolean;progress?:{completed:number;total:number|null};topicProgress?:{completed:number;total:number};result?:{message?:string;created_document_id?:string;generated_documents?:number;prUrl?:string;results?:unknown[];verdict?:string;findings?:Array<{severity:string;description:string;steps?:string;expected?:string;actual?:string}>;checks?:Array<{name:string;result:string;details:string}>;commit?:string}|null;taskId?:string};
export type ProjectProcessEvent={id:string;stage:string;detail:string;level:string;created_at:string};
export type ProcessFilter='all'|'active'|'failed'|'completed';
export function processStatus(status:string){
 return status==='completed'?'Завершён':status==='partial'?'Частично завершён':
  status==='failed'?'Ошибка':status==='queued'?'В очереди':
  status==='running'?'Выполняется':status==='cancelled'?'Остановлен':
  status==='logged'?'Промпт сохранён':status==='stale'?'Нужно подтвердить заново':status;
}
export function compactProcessDescription(detail:string):string{
 const normalized=detail.replace(/\s+/g,' ').trim();
 if(!normalized)return 'Подробности доступны справа.';
 if(normalized.length<=110)return normalized;
 const boundary=normalized.lastIndexOf(' ',110);
 return normalized.slice(0,boundary>=65?boundary:110).trimEnd()+'…';
}
export function filterProjectProcesses(processes:readonly ProjectProcess[],filter:ProcessFilter):ProjectProcess[]{
 return processes.filter(p=>filter==='all'||(filter==='active'
  ?['queued','running'].includes(p.status):p.status===filter));
}
export function selectProjectProcess(processes:readonly ProjectProcess[],selectedId:string|null,filter:ProcessFilter):ProjectProcess|undefined{
 return processes.find(p=>p.id===selectedId)||filterProjectProcesses(processes,filter)[0];
}
