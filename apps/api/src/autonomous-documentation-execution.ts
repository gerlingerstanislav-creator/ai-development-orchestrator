/** Continue a documentation agent from durable MCP evidence after a bounded Codex call.
 * Temporal owns the job. This module never changes job state or writes documents.
 */
export type DocumentationAgentEvent={
 id:string;tool:string;success:boolean;result?:unknown;
};
export type DocumentationAgentState={status:string;message?:string|null};
type ProgressStage='verified'|'waiting_input'|'retrying'|'continuation';
type DocumentationRounds={
 readState:()=>Promise<DocumentationAgentState>;
 readEvents:()=>Promise<DocumentationAgentEvent[]>;
 runRound:(step:number,history:string)=>Promise<string>;
 onProgress:(stage:ProgressStage,detail:string)=>Promise<void>;
 maxRounds?:number;
 maxIdleRounds?:number;
};

export function recoverableDocumentAgentError(error:unknown):boolean{
 const reason=error instanceof Error?error.message:String(error);
 return /превысил ограничение времени|превышено время|timed?\\s*out|timeout|AbortError|aborted|ETIMEDOUT|ECONNRESET|ECONNABORTED|fetch failed|socket hang up|502 Bad Gateway|503 Service Unavailable|исполнитель этой роли занят|очередь агентных диалогов заполнена|несколько AI-диалогов/i.test(reason);
}

/** Event results are evidence, not instructions. Keep only bounded excerpts. */
export function documentationAgentHistory(events:DocumentationAgentEvent[],lastMessage=''):string{
 const tools=events.slice(0,18).reverse().map(event=>{
  let details='';
  if(event.result!==undefined){
   try{details=JSON.stringify(event.result).slice(0,320);}
   catch{details='не удалось прочитать результат';}
  }
  return (event.success?'✓ ':'✗ ')+event.tool+(details?' · '+details:'');
 });
 const result=[
  lastMessage?'Последний ответ/сбой агента: '+lastMessage.slice(0,600):'',
  tools.length?'Сохранённые вызовы MCP этого поручения (уже выполнены; не дублируй запись):\\n'+tools.join('\\n'):''
 ].filter(Boolean).join('\\n');
 return result.slice(-5700);
}

/** A Codex CLI timeout is a per-round interruption, not a failed Temporal job.
 * Verify terminal state AFTER the HTTP call (including errors), then resume
 * with previous tool evidence. Stop only after bounded attempts without progress.
 */
export async function advanceDocumentationAgent(options:DocumentationRounds):Promise<void>{
 const maxRounds=options.maxRounds??10,maxIdleRounds=options.maxIdleRounds??3;
 let events=await options.readEvents();
 let marker=events[0]?.id??null;
 let history=documentationAgentHistory(events);
 let idle=0;
 for(let step=1;step<=maxRounds;step++){
  const before=await options.readState();
  if(before.status==='completed'||before.status==='waiting_input')return;
  if(before.status!=='running')throw Error('Поручение аналитика больше не активно: '+before.status);
  let message='',failure:unknown=null;
  try{message=await options.runRound(step,history);}
  catch(error){failure=error;}
  // MCP documentation.complete / request_input may have committed BEFORE the
  // Codex process timed out or failed to return an HTTP response.
  const state=await options.readState();
  if(state.status==='completed'){
   await options.onProgress('verified','Документы подтверждены средствами MCP');
   return;
  }
  if(state.status==='waiting_input'){
   await options.onProgress('waiting_input',String(state.message||'Ожидаются сведения ПМ'));
   return;
  }
  if(state.status!=='running')throw Error('Поручение аналитика больше не активно: '+state.status);
  events=await options.readEvents();
  const newMarker=events[0]?.id??null;
  const progressed=newMarker!==marker;
  marker=newMarker;
  if(failure&&!recoverableDocumentAgentError(failure))throw failure;
  idle=progressed?0:idle+1;
  const reason=failure instanceof Error?failure.message:String(failure||'');
  history=documentationAgentHistory(events,message||reason);
  if(failure)history+='\\nПредыдущий вызов Codex был прерван. Используй сохранённые результаты MCP и продолжай с последнего подтверждённого действия, не повторяя выполненные изменения.';
  if(idle>=maxIdleRounds){
   throw Error('Аналитик не продвигается: '+idle+' последовательных шага без новых вызовов MCP. Сохранённая история доступна для возобновления. Последний результат: '+(reason||message||'нет').slice(0,220));
  }
  if(failure){
   await options.onProgress('retrying','Вызов Codex прервался; аналитик продолжает по истории MCP · шаг '+step+'/'+maxRounds+' · '+reason.slice(0,250));
  }else{
   await options.onProgress('continuation','Аналитик продолжает поручение: подтверждённого завершения или вопроса пока нет');
  }
 }
 throw Error('Аналитик не завершил поручение за отведённое число шагов. История MCP сохранена; возобновление продолжит существующий импорт.');
}
