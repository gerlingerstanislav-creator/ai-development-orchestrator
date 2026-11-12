import React from 'react';

export type QaEvidenceRun={
 id:string;status:string;verdict?:string|null;
 qa_plan_snapshot?:{cases?:Array<{id:string;title?:string;description?:string;preconditions?:string;steps?:Array<{action:string;expected:string}>;purpose?:string}>}|null;
 report?:{summary?:string;screenshots?:Array<{mime:string;data:string;name:string}>;capabilities?:string;caseResults?:Array<{case_id:string;result:string;reason?:string;evidence?:string}>;checks?:Array<{name:string;result:string;details?:string}>}|null;
};
const statusText:Record<string,string>={passed:'Пройден',failed:'Ошибка',blocked:'Недоступен',not_run:'Не проверялся'};
export function QaRunEvidence({run}:{run:QaEvidenceRun}){
 const source=run.qa_plan_snapshot?.cases||[];
 const results=run.report?.caseResults||[];
 const byId=new Map(results.map(r=>[r.case_id,r]));
 const cases=source.length?source.map(c=>({id:c.id,title:c.title||c.id,description:c.description||'',steps:c.steps||[],result:byId.get(c.id)}))
  :results.map(r=>({id:r.case_id,title:r.case_id,description:'',steps:[] as Array<{action:string;expected:string}>,result:r}));
 if(!cases.length&&!run.report?.checks?.length)return null;
 const passed=cases.filter(c=>c.result?.result==='passed').length;
 const failed=cases.filter(c=>c.result?.result==='failed').length;
 const unverified=cases.length-passed-failed;
 const checks=run.report?.checks||[];
 const checkPassed=checks.filter(c=>c.result==='passed').length;
 return <section className="qa-evidence-panel" aria-label="Подробные результаты тестирования">
  <div className="row-line"><strong>Результаты QA</strong><small className="muted">{run.verdict==='passed'?'Проверки пройдены':run.verdict==='failed'?'Обнаружены ошибки':'Проверено частично'}</small></div>
  <p><strong>Тест-кейсы: {passed} из {cases.length} пройдено.</strong> {failed>0?'Ошибок: '+failed+'. ':''}{unverified>0?'Не подтверждено: '+unverified+'. ':''}</p>
  <p className="muted">Дополнительные команды: {checkPassed} из {checks.length} успешны. Они не засчитываются за отдельные тест-кейсы без подтверждённого результата по ID.</p>
  {cases.map((item,index)=>{
   const result=item.result;
   const state=result?.result||'not_run';
   return <details className="qa-evidence-case" key={item.id}>
    <summary><span>{index+1}. {item.title}</span><strong>{statusText[state]||state}</strong></summary>
    {item.description&&<p>{item.description}</p>}
    {item.steps.length>0&&<ol>{item.steps.map((step,i)=><li key={i}>{step.action} — <strong>{step.expected}</strong></li>)}</ol>}
    <p><strong>Фактический результат:</strong> {result?.evidence||'Подтверждённого результата пока нет'}</p>
    {result?.reason&&state!=='passed'&&<small className="muted">Причина: {result.reason}</small>}
   </details>;
  })}
  {checks.length>0&&<details className="qa-evidence-case">
   <summary>Дополнительные проверки ({checkPassed}/{checks.length})</summary>
   {checks.map((check,index)=><p key={index}><strong>{statusText[check.result]||check.result}: {check.name}</strong> — {check.details||'Нет сведений'}</p>)}
  </details>}
  {!!run.report?.screenshots?.length&&<details className="qa-evidence-case"><summary>Скриншоты проверки ({run.report.screenshots.length})</summary>
   <div className="qa-evidence-images">{run.report.screenshots.map((shot,i)=><a key={shot.name||i} href={'data:'+shot.mime+';base64,'+shot.data} target="_blank" rel="noreferrer"><img src={'data:'+shot.mime+';base64,'+shot.data} alt={'Скриншот QA '+(i+1)}/></a>)}</div>
  </details>}
  {run.report?.capabilities&&<details className="qa-evidence-case"><summary>Инструменты QA</summary><pre>{run.report.capabilities}</pre></details>}
 </section>;
}
