import React from 'react';
import {Clock3,FileDown} from 'lucide-react';
import {KnowledgeAudit} from '../../KnowledgeAudit.js';
import {api} from '../../api/client.js';
import {projectUrl} from '../navigation/routes.js';
import type {AgentPromptAudit} from './AgentPromptDisclosure.js';
import {
 compactProcessDescription,filterProjectProcesses,processStatus,selectProjectProcess,
 type ProjectProcess,type ProjectProcessEvent,type ProcessFilter
} from './process-center-model.js';

type Command=(process:ProjectProcess)=>void|Promise<void>;
export type ProcessCenterProps={
 projectId:string;
 processes:ProjectProcess[];
 events:ProjectProcessEvent[];
 prompts:AgentPromptAudit[];
 selectedProcessId:string|null;
 onSelectProcess:(processId:string)=>void;
 filter:ProcessFilter;
 onFilterChange:(filter:ProcessFilter)=>void;
 diagnosticHours:number;
 onDiagnosticHoursChange:(hours:number)=>void;
 includeMessages:boolean;
 onIncludeMessagesChange:(value:boolean)=>void;
 exporting:boolean;
 onDownloadDiagnostics:()=>void|Promise<void>;
 actionBusy:boolean;
 instruction:string;
 onInstructionChange:(value:string)=>void;
 onInterrupt:Command;
 onRestartImport:Command;
 onSendInstruction:Command;
 onStopAnalyst:Command;
 onFollowLink:(event:React.MouseEvent<HTMLAnchorElement>,path:string)=>void;
 onNavigate:(path:string)=>void;
};

/** Process Center presentation only. Data retrieval, polling and commands
 * remain owned by the project application state.
 */
export function ProcessCenter({
 projectId,processes,events,prompts,selectedProcessId,onSelectProcess,
 filter,onFilterChange,diagnosticHours,onDiagnosticHoursChange,
 includeMessages,onIncludeMessagesChange,exporting,onDownloadDiagnostics,
 actionBusy,instruction,onInstructionChange,onInterrupt,onRestartImport,
 onSendInstruction,onStopAnalyst,onFollowLink,onNavigate
}:ProcessCenterProps){
 return <div className="process-center">
  <div className="process-center-heading">
    <div><h2>Центр процессов</h2><p className="muted">История работы AI и фоновых операций текущего проекта</p></div>
    <div className="row-line" style={{gap:8,flexWrap:'wrap'}}>
     <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13}}>Логи за
      <select value={diagnosticHours} onChange={e=>onDiagnosticHoursChange(Number(e.target.value))}>
       <option value={1}>1 час</option><option value={24}>24 часа</option><option value={72}>3 дня</option><option value={168}>7 дней</option>
      </select>
     </label>
     <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13}} title="Добавляет тексты сообщений в чатах проекта, ПМ и задач. Перед отправкой проверь скачанный файл.">
      <input type="checkbox" checked={includeMessages} onChange={e=>onIncludeMessagesChange(e.target.checked)}/>
      Переписка
     </label>
     <button type="button" className="secondary" disabled={exporting} onClick={()=>void onDownloadDiagnostics()}>
      <FileDown size={15}/> {exporting?'Подготовка…':'Скачать логи'}
     </button>
    </div>
   </div>
  <div className="process-center-filters">{([['all','Все'],['active','Активные'],['failed','Ошибки'],['completed','Завершённые']] as const).map(([value,label])=>
   <button key={value} className={filter===value?'selected':''} type="button" onClick={()=>onFilterChange(value)}>{label}</button>)}</div>
  <div className="process-center-grid">
   <div className="panel process-list">
    {filterProjectProcesses(processes,filter).map(process=>
     <button type="button" key={process.id} className={'process-list-item '+(selectedProcessId===process.id?'selected':'')} onClick={()=>onSelectProcess(process.id)}>
      <span className="process-list-title">{['running','queued'].includes(process.status)&&process.kind==='testing'?
       <span className="agent-equalizer" aria-label="Тестировщик выполняет проверку" role="status"><i/><i/><i/></span>:
       <span className={'process-dot '+process.status}/>}<strong>{process.title}</strong></span>
      <small>{processStatus(process.status)} · {new Date(process.updatedAt||process.createdAt).toLocaleString('ru-RU')}</small>
      <span className="process-list-summary">{compactProcessDescription(process.detail)}</span>
     </button>)}
    {!processes.length&&<p className="muted process-empty">Процессов пока нет</p>}
   </div>
   <div className="panel process-detail">{(()=>{
    const process=selectProjectProcess(processes,selectedProcessId,filter);
    if(!process)return <div className="process-detail-empty"><Clock3 size={28}/><p>Выбери процесс слева, чтобы увидеть его результат и историю.</p></div>;
    return <>
     <div className="process-detail-header"><h3>{process.title}</h3><span className={'process-status '+process.status}>{processStatus(process.status)}</span></div>
     <p className="muted">{process.detail}</p>
     {['queued','running'].includes(process.status)&&(['development','testing'].includes(process.kind)||process.title.startsWith('План задач')||process.title.startsWith('Анализ задачи'))&&
      <div className="process-actions"><button type="button" className="secondary" disabled={actionBusy} onClick={()=>void onInterrupt(process)}>Прервать процесс</button></div>}
     {process.kind==='document_import'&&<div className="process-metrics"><span>Файлов: {process.sourceFileCount??'—'}</span><span>Фрагментов: {process.progress?.completed??0} / {process.progress?.total??'—'}</span><span>Тем готово: {process.topicProgress?.completed??0} / {process.topicProgress?.total||'—'}</span><span>Сохранено страниц: {process.savedDocuments??0}</span></div>}
     {process.taskId&&<p className="process-source"><a href={projectUrl(projectId,'tasks')+'/'+process.taskId} onClick={e=>onFollowLink(e,projectUrl(projectId,'tasks')+'/'+process.taskId)}>Открыть задачу и чат агента</a></p>}
     {process.sourceUrl&&<p className="process-source"><a href={process.sourceUrl} target="_blank" rel="noreferrer">Исходный репозиторий</a></p>}
     {selectedProcessId===process.id&&prompts.length>0&&<details className="process-prompt-audit" style={{margin:'12px 0'}}>
      <summary style={{cursor:'pointer',fontWeight:600}}>Промпты запусков ({prompts.length})</summary>
      <p className="muted">Текст, переданный модели, с маскировкой известных секретов. Для повторных запусков показаны отдельные запросы.</p>
      {prompts.map(entry=><details key={entry.id} style={{margin:'8px 0'}}>
       <summary style={{cursor:'pointer'}}>{entry.role} · {new Date(entry.created_at).toLocaleString('ru-RU')} · {entry.original_chars} символов{entry.truncated?' · сокращённый журнал':''}</summary>
       <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:480,overflow:'auto',fontSize:12,padding:12,background:'var(--panel-bg, rgba(127,127,127,.06))',borderRadius:8}}>{entry.prompt}</pre>
      </details>)}
     </details>}

     {process.result&&<div className="process-result"><strong>Результат</strong><p>{process.result.message||'Операция завершена'}</p>
      {process.kind==='agent'&&<>
       {process.result.role&&<p><strong>Исполнитель:</strong> {process.result.role}</p>}
       {process.result.acceptance&&<p><strong>Критерии:</strong> {process.result.acceptance}</p>}
       {process.result.evidence&&<p><strong>Доказательства:</strong> {process.result.evidence}</p>}
       {process.result.reviewerNote&&<p><strong>Решение ПМ:</strong> {process.result.reviewerNote}</p>}
      </>}
      {process.iterationId&&projectId&&<button className="secondary" onClick={()=>onNavigate(projectUrl(projectId,'plan')+'/'+process.iterationId)}>Открыть итерацию</button>}
      {process.result.created_document_id&&<button className="secondary" onClick={()=>onNavigate(projectUrl(projectId,'docs')+'/'+process.result!.created_document_id)}>Открыть документацию</button>}
      {process.result.verdict&&<p><strong>Вердикт: {process.result.verdict==='passed'?'Проверки пройдены':process.result.verdict==='failed'?'Обнаружены ошибки':'Не удалось проверить'}</strong></p>}
      {process.result.commit&&<small>Проверенный коммит: {process.result.commit}</small>}
      {process.result.findings?.map((finding,i)=><p key={i}><strong>{finding.severity}:</strong> {finding.description}{finding.steps?' · '+finding.steps:''}</p>)}
      {process.result.checks?.map((check,i)=><p key={'check-'+i}>{check.name}: {check.result} · {check.details}</p>)}
      {process.result.prUrl&&<a href={process.result.prUrl} target="_blank" rel="noreferrer">Открыть PR</a>}
     </div>}
     {process.kind==='document_import'&&process.status==='failed'&&<div className="process-actions">
      <button className="secondary" disabled={actionBusy} onClick={()=>void onRestartImport(process)}>Возобновить тот же импорт</button>
      <small>Готовые страницы сохранены; возобновление использует тот же процесс и пропускает завершённые темы.</small>
     </div>}
     {process.kind==='document_import'&&process.status==='running'&&<div className="process-instruction-box">
      <strong>Диалог с аналитиком во время работы</strong>
      <p>Новые сообщения попадут в контекст следующего шага. Если ответ уже формируется, агент пересчитает его с учётом уточнения.</p>
      <textarea rows={3} value={instruction} onChange={e=>onInstructionChange(e.target.value)} placeholder="Добавить требование или уточнить решение…"/>
      <div className="process-actions">
       <button className="secondary" disabled={actionBusy||!instruction.trim()} onClick={()=>void onSendInstruction(process)}>Отправить аналитику</button>
       <button className="secondary" disabled={actionBusy} onClick={()=>void onStopAnalyst(process)}>Прервать работу</button>
      </div>
     </div>}
     {process.kind==='document_import'&&process.status==='cancelled'&&<p className="muted">Работа остановлена. Уже сохранённые страницы и контрольные точки остаются в проекте.</p>}
     {projectId&&process.taskId&&<KnowledgeAudit projectId={projectId} taskId={process.taskId} processId={process.id} request={api}/>}
     <h4>Журнал событий</h4>
     {events.length&&selectedProcessId===process.id?<div className="process-timeline">{[...events].reverse().map(ev=><div className={'process-timeline-item '+ev.level} key={ev.id}><small>{new Date(ev.created_at).toLocaleString('ru-RU')} · {ev.stage}</small><div>{ev.detail}</div></div>)}</div>:
      <p className="muted">Для этого процесса подробный журнал пока отсутствует или загружается.</p>}
    </>;
   })()}</div>
  </div>
 </div>;
}
