import {qaReadableSummary} from './qa-readable-summary.js';

/** Render one human-readable QA message from persisted structured evidence. */
type CaseResult={case_id:string;result:string;evidence?:string;reason?:string};
type QaCase={id:string;title?:string};
export type QaReportRun={
 status:string;verdict?:string|null;message?:string|null;
 report?:{
  summary?:string;caseResults?:CaseResult[];
  findings?:Array<{severity?:string;description?:string}>;
  checks?:Array<{name?:string;result?:string;details?:string}>;
 }|null;
 qa_plan_snapshot?:{cases?:QaCase[]}|null;
};
const mark=(value:string)=>value==='passed'?'✅':value==='failed'?'❌':value==='blocked'?'⚠️':'➖';
const description=(value:string)=>value==='passed'?'пройден':value==='failed'?'не пройден':value==='blocked'?'нет возможности проверить':'не выполнялся';
const safe=(value:unknown,max=240)=>String(value??'').replace(/[\r\n]+/g,' ').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max);
const md=(value:unknown,max=240)=>safe(value,max).replace(/[\\*_{}\[\]()#+.!|<>~-]/g,'\\$&').replace(/\x60/g,'\\\x60');
const readableEvidence=(value:unknown,status:string)=>{
 if(status==='passed')return '';
 const raw=safe(value,220);
 if(!raw||/\[(qa-exec|Chromium\/Playwright)\]|\/opt\/codex-runner|\/var\/lib\/ado-|\/bin\/bash -c/i.test(raw))
  return '';
 return md(raw,150);
};

export function formatQaReportMessage(run:QaReportRun):string{
 const report=run.report||{};
 const expected=Array.isArray(run.qa_plan_snapshot?.cases)?run.qa_plan_snapshot.cases:[];
 const provided=Array.isArray(report.caseResults)?report.caseResults:[];
 const byId=new Map(provided.filter(c=>c&&typeof c.case_id==='string').map(c=>[c.case_id,c]));
 const cases=expected.length?expected.map(c=>({
  title:c.title||'Тест-кейс '+c.id,result:byId.get(c.id)||{case_id:c.id,result:'not_run',evidence:'Нет результата'}
 })):provided.map(c=>({title:'Тест-кейс '+c.case_id,result:c}));
 const passed=cases.filter(c=>c.result.result==='passed').length;
 const failed=cases.filter(c=>c.result.result==='failed').length;
 const blocked=cases.filter(c=>['blocked','not_run'].includes(c.result.result)).length;
 const verdict=run.verdict==='passed'?'✅ Проверки пройдены':run.verdict==='failed'?'❌ Обнаружены дефекты':
  run.status==='failed'?'❌ Ошибка запуска тестирования':'⚠️ Проверки завершены не полностью';
 const lines=['### Тестировщик · '+verdict];
 if(cases.length){
  lines.push('**Тест-кейсы: '+passed+' из '+cases.length+' пройдено'+(failed?', '+failed+' не пройдено':'')+(blocked?', '+blocked+' не подтверждено':'')+'.**');
  lines.push('');
  for(const [index,item] of cases.entries()){
   const result=item.result.result;
   const evidence=readableEvidence(item.result.evidence,result);
   lines.push('- '+mark(result)+' **'+(index+1)+'. '+md(item.title)+'** — '+description(result)+(evidence?' · '+evidence:''));
  }
 }else if(run.status==='completed'){
  lines.push('Тест-кейсы в сохранённом плане отсутствуют; результаты нужно проверить.');
 }
 const checks=Array.isArray(report.checks)?report.checks:[];
 if(checks.length){
  lines.push('','**Дополнительные проверки:**');
  for(const check of checks){
   const status=String(check.result||'not_run');
   lines.push('- '+mark(status)+' '+md(check.name||'Проверка')+' — '+description(status));
  }
 }
 const findings=Array.isArray(report.findings)?report.findings:[];
 if(findings.length){
  lines.push('','**Подтверждённые дефекты:**');
  for(const finding of findings)lines.push('- ❌ '+md(finding.description||'Дефект',340));
 }
 const summary=qaReadableSummary({
  verdict:run.verdict,caseResults:cases.map(c=>c.result),
  checks,findings,
 },cases.length);
 lines.push('','**Итог:** '+md(summary,950));
 if(run.verdict==='failed')
  lines.push('**Дальше:** исправить выявленные ошибки или уточнить проверяемую версию, затем повторить QA.');
 else if(run.verdict==='blocked')
  lines.push('**Дальше:** устранить причину блокировки и повторить непроверенные сценарии.');
 if(run.verdict==='blocked')lines.push('','Непроверенные сценарии не считаются успешными; решение о дальнейших действиях принимает владелец.');
 return lines.join('\n');
}

/** Older process events stored the full QA JSON; never surface that blob as prose. */
export function qaEventDetail(raw:string):string{
 const input=String(raw||'').trim();
 if(!input.startsWith('{'))return input;
 try{
  const data=JSON.parse(input);
  if(!data||typeof data!=='object'||!('summary' in data))return input;
  // Legacy event JSON may include an invented "all tests passed" summary
  // while its saved caseResults contain failures. Never repeat the lie.
  if(Array.isArray(data.caseResults)&&data.caseResults.some((item:{result?:string})=>item.result!=='passed')||
    Array.isArray(data.checks)&&data.checks.some((item:{result?:string})=>item.result==='failed')||
    Array.isArray(data.findings)&&data.findings.length)
   return qaReadableSummary({caseResults:data.caseResults,checks:data.checks,findings:data.findings},data.caseResults?.length);
  return safe(data.summary||'QA завершил проверку. Полный отчёт находится в сообщении тестировщика.',1100);
 }catch{return input;}
}
