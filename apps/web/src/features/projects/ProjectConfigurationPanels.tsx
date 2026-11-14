import React from 'react';
import {KeyRound,RotateCcw,Settings2} from 'lucide-react';
import {aiAgentName,serviceStages} from '../../agent-labels.js';

export type Stage={stage:string,label:string,description:string,mode:'automatic'|'approval'|'manual',position:number,agent_name:string,agent_instructions:string,responsibility?:{role:string|null;trigger:string;result:string;participants?:{role:string;assignment:string}[]}|null};
export type Connection={id:string,name:string,provider:string};
export type GitLink={repository:string,default_branch:string,target_branch?:string,connection_id:string,connection_name?:string};
export type AiSettings={model:'gpt-6-luna'|'gpt-6-sol'|'gpt-6.1-sol';reasoning:'low'|'medium';enabled:boolean};

/** Pure project configuration views. All state and API effects remain in App. */
export function ProjectWorkflowDiagram({
 stages,deploymentMode,onOpenStage
}:{
 stages:Stage[];
 deploymentMode:'skip'|'manual'|'automatic';
 onOpenStage:(stage:Stage)=>void;
}){
 return (<section className="panel workflow-settings-panel">
  <div className="row-line">
   <div><h3>Workflow · Схема процесса</h3><p className="muted">Нажми на этап, чтобы посмотреть его назначение или настроить агента.</p></div>
   <span className="workflow-key"><span className="workflow-key-line"/> Переходы</span>
  </div>
  <div className="workflow-diagram-scroll">
   <div className="workflow-diagram" role="group" aria-label="Последовательность этапов проекта">
    {stages.map((stage,i)=><React.Fragment key={stage.stage}>
      {i>0&&<div className="workflow-diagram-connector" tabIndex={0}
       aria-label={'Переход: '+stages[i-1].label+' → '+stage.label}
       data-tooltip={stages[i-1].label+' → '+stage.label}>
       <svg viewBox="0 0 28 14" width="28" height="14" aria-hidden="true">
        <path d="M 1 7 H 25 M 20 2 L 25 7 L 20 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
       </svg>
      </div>}
      <button type="button" className={'workflow-stage-card workflow-stage-'+stage.stage} onClick={()=>onOpenStage(stage)}
       title={'Настройки этапа «'+stage.label+'»'}>
       <span className="workflow-stage-label">{stage.label}</span>
       <span className="workflow-stage-description">{stage.description||'Описание не задано'}</span>
       <span className="workflow-stage-agent">{serviceStages[stage.stage]?'Служебный этап':stage.agent_name?aiAgentName(stage.agent_name):'Исполнитель не указан'}</span>
       <span className="workflow-stage-mode">{stage.stage==='deployment'?(deploymentMode==='skip'?'Пропуск без окружения':deploymentMode==='automatic'?'GitHub Actions + проверка':'Ручное подтверждение'):stage.mode==='automatic'?'Автоматически':stage.mode==='approval'?'С подтверждением':'Вручную'}</span>
       <Settings2 size={14} className="workflow-stage-icon"/>
      </button>
     </React.Fragment>)}
   </div>
   {stages.some(stage=>stage.stage==='testing')&&stages.some(stage=>stage.stage==='development')&&
    <div className="workflow-feedback" style={{width:stages.length*148+(stages.length-1)*28}}>
     {(()=>{
      const development=stages.findIndex(stage=>stage.stage==='development');
      const testing=stages.findIndex(stage=>stage.stage==='testing');
      const x1=development*176+74,x2=testing*176+74;
      const width=x2-x1+20;
      return <div className="workflow-feedback-link" tabIndex={0} role="img"
       aria-label="Возврат из тестирования в разработку при ошибках с замечаниями и повторной проверкой"
       style={{left:x1-10,width}}>
       <svg className="workflow-feedback-path" viewBox={`0 0 ${width} 30`} preserveAspectRatio="none" aria-hidden="true">
        <path d={`M ${width-10} 1 V 10 Q ${width-10} 23 ${width-23} 23 H 23 Q 10 23 10 10 V 1`}
         fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M 5 8 L 10 1 L 15 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
       </svg>
       <div className="workflow-feedback-tooltip" role="tooltip">
        <RotateCcw size={13}/> Тестирование → Разработка: найденные ошибки, замечания и повторная проверка
       </div>
      </div>;
     })()}
    </div>}
  </div>

 </section>);
}

export function ProjectSettingsPanel({
 aiSettings,onAiSettingsChange,aiBusy,onSaveAiSettings,aiMessage,
 gitRepository,onGitRepositoryChange,targetBranch,onTargetBranchChange,
 gitTokenId,onGitTokenIdChange,connections,gitLink,gitBusy,gitMessage,
 onSaveGitLink,onRemoveGitLink,onFollowLink
}:{
 aiSettings:AiSettings;
 onAiSettingsChange:(value:AiSettings)=>void;
 aiBusy:boolean;
 onSaveAiSettings:()=>void;
 aiMessage:string;
 gitRepository:string;
 onGitRepositoryChange:(value:string)=>void;
 targetBranch:string;
 onTargetBranchChange:(value:string)=>void;
 gitTokenId:string;
 onGitTokenIdChange:(value:string)=>void;
 connections:Connection[];
 gitLink:GitLink|null;
 gitBusy:boolean;
 gitMessage:string;
 onSaveGitLink:()=>void;
 onRemoveGitLink:()=>void;
 onFollowLink:(event:React.MouseEvent<HTMLAnchorElement>,path:string)=>void;
}){
 return (<section className="panel project-settings-panel">
  <h3>AI-агенты</h3>
  <p className="muted">Модель и режим работы AI-агентов этого проекта. Запуском управляют задачи и процесс разработки.</p>
  <div className="settings-grid">
   <label>Модель по умолчанию<select value={aiSettings.model} onChange={e=>onAiSettingsChange({...aiSettings,model:e.target.value as AiSettings['model']})}>
    <option value="gpt-6-luna">GPT-6 Luna — экономный вариант</option>
    <option value="gpt-6-sol">GPT-6 Sol — сложнее задачи</option>
    <option value="gpt-6.1-sol">GPT-6.1 Sol — более мощная</option>
   </select></label>
   <label>Глубина рассуждений<select value={aiSettings.reasoning} onChange={e=>onAiSettingsChange({...aiSettings,reasoning:e.target.value as AiSettings['reasoning']})}>
    <option value="low">Низкая — экономит лимиты</option><option value="medium">Средняя</option>
   </select></label>
  </div>
  <label style={{display:'flex',flexDirection:'row',alignItems:'center',gap:10}}>
   <input type="checkbox" checked={aiSettings.enabled} onChange={e=>onAiSettingsChange({...aiSettings,enabled:e.target.checked})} style={{width:18,height:18}}/>
   Разрешить работу AI-агентов
  </label>
  <p className="muted">Подключение ChatGPT и сведения о лимитах доступны в настройках профиля.</p>
  <button className="primary" disabled={aiBusy} onClick={()=>void onSaveAiSettings()}>Сохранить настройки AI</button>
  {aiMessage&&<p>{aiMessage}</p>}
 <div className="project-settings-divider"/>
  <div className="row-line"><h3>Репозиторий GitHub</h3><a className="secondary profile-settings-link" href="/account/settings" onClick={e=>onFollowLink(e,'/account/settings')}><KeyRound size={15}/> Управлять токенами</a></div>
  <p className="muted">Выбери репозиторий, целевую ветку PR и одно из личных подключений GitHub. Токены создаются и редактируются в профиле.</p>
  <div className="settings-grid">
   <label>Репозиторий (owner/name)<input value={gitRepository} placeholder="gerlingerstanislav-creator/ai-development-orchestrator" onChange={e=>onGitRepositoryChange(e.target.value)} /></label>
   <label>Целевая ветка PR<input value={targetBranch} placeholder={gitLink?.default_branch||'main'} onChange={e=>onTargetBranchChange(e.target.value)} /></label>
   <label>Подключение GitHub<select value={gitTokenId} onChange={e=>onGitTokenIdChange(e.target.value)}><option value="">Выбери подключение</option>{connections.filter(c=>c.provider==='github_token').map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
  </div>
  {connections.every(c=>c.provider!=='github_token')&&<p className="muted">Нет сохранённых токенов. <a href="/account/settings" onClick={e=>onFollowLink(e,'/account/settings')}>Добавить токен в профиле</a>, затем вернись к настройкам проекта.</p>}
  {gitLink&&<p className="muted">Привязан: <strong>{gitLink.repository}</strong> · целевая ветка PR: <strong>{gitLink.target_branch||gitLink.default_branch}</strong></p>}
  {gitMessage&&<p>{gitMessage}</p>}
  <div className="codex-actions">
   <button className="primary" disabled={gitBusy||!gitTokenId||!gitRepository.trim()} onClick={()=>void onSaveGitLink()}>Проверить и сохранить</button>
   {gitLink&&<button className="secondary" disabled={gitBusy} onClick={()=>void onRemoveGitLink()}>Отвязать репозиторий</button>}
  </div>
 </section>);
}
