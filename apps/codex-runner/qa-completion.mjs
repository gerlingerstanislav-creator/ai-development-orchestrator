import {assembleAgentPrompt} from '../api/src/prompt-assembler.mjs';
import {isVisualAcceptanceCase} from '../api/src/qa-visual-case.mjs';
/**
 * A QA run is not finished merely because the model produced valid JSON.
 * Ask for one targeted follow-up when a real browser is available but some
 * acceptance cases lack trusted evidence tied to their own case ID.
 *
 * No results are asserted here: only the existing trusted browser gateway
 * and qa-exec receipts can change an acceptance-case verdict.
 */
export function incompleteQaCases(report,plan=[],{browserAvailable=false,maxCases=8}={}){
 if(!browserAvailable)return [];
 const byId=new Map((plan||[]).map(item=>[item.id,item]));
 const isVisual=item=>isVisualAcceptanceCase({...byId.get(item.case_id),title:byId.get(item.case_id)?.title||item.title});

 return (report?.caseResults||[])
  .filter(item=>['blocked','not_run'].includes(item.result)||
    (item.result==='passed'&&!item.browserVerified&&isVisual(item)))
  .slice(0,maxCases)
  .map(item=>{
   const spec=byId.get(item.case_id)||{};
   return {
    id:item.case_id,
    title:String(item.title||spec.title||item.case_id).slice(0,240),
    steps:(Array.isArray(spec.steps)?spec.steps:[]).slice(0,8)
     .map(step=>({action:String(step.action||'').slice(0,350),expected:String(step.expected||'').slice(0,350)})),
    priorResult:item.result,
    priorReason:String(item.reason||'unknown').slice(0,80),
    priorEvidence:String(item.evidence||'').slice(0,350)
   };
  });
}
/** A shell check is never enough to prove visual acceptance without a
 * case-linked browser assertion. Share exactly the API's classification.
 */
export function applyVisualEvidenceGate(report,plan=[],{browserAvailable=false}={}){
 const expected=new Map((plan||[]).map(item=>[item.id,item]));
 const cases=(report.caseResults||[]).map(item=>{
  const spec=expected.get(item.case_id)||{};
  if(item.result!=='passed'||item.browserVerified===true||
   !isVisualAcceptanceCase({...spec,title:spec.title||item.title}))return item;
  return {...item,result:'blocked',reason:browserAvailable?'unverified':'tool_unavailable',
   evidence:browserAvailable
    ?'Для визуального критерия '+item.case_id+' нет исполненной Chromium assert --case '+item.case_id+
     '. Командный receipt не подтверждает фактическую отрисовку.'
    :'Браузерная проверка '+item.case_id+' не выполнялась: Chromium недоступен.'};
 });
 const verdict=cases.some(c=>c.result==='failed')||report.checks?.some(c=>c.result==='failed')
  ?'failed':cases.some(c=>c.result!=='passed')?'blocked':report.verdict;
 return {...report,caseResults:cases,verdict};
}
export function qaCompletionPrompt(cases,{taskTitle='',taskDescription=''}={}){
 return assembleAgentPrompt({
  identity:'Независимый QA-специалист, допроверяющий недостающие кейсы',
  objective:'Адресно проверь только перечисленные критерии приёмки на том же SHA. '+String(taskTitle).slice(0,180)+
   '\n'+String(taskDescription).slice(0,800)+'\nКейсы и ожидаемые результаты:\n'+JSON.stringify(cases),
  scope:'Та же временная копия проекта и уже созданная защищённая браузерная сессия.',
  policy:'Не меняй код, не создавай PR и не выдумывай результаты. Не объявляй выполненным ничего, для чего нет фактического доказательства.',
  tools:'Для визуального критерия: node /opt/codex-runner/browser-client.mjs assert --case CASE_ID "JS-условие". Для команды: node /opt/codex-runner/qa-exec.mjs case CASE_ID -- КОМАНДА. При необходимости browser-client.mjs start/goto/viewport.',
  protocol:'Сначала прочитай реальные DOM-элементы страницы и составь проверяемое JS-условие для каждого case_id. ОБЯЗАТЕЛЬНО выполни реальную browser-client.mjs assert --case СООТВЕТСТВУЮЩИЙ_ID с содержательным JS-условием, а не просто напиши об этом в ответе. Проверь количество, геометрию, computed style и видимость согласно требованиям. Не используй константное true или доказательство другого кейса. При проблеме с инструментом верни blocked с точной причиной. Не повторяй всю регрессию. Runner независимо сверит assertions и receipts.',
  output:'Верни короткий JSON в установленном формате. Текст отчёта не засчитывается в доказательства. Не запускал проверку — отметь blocked/not_run.',
  budget:14000
 });
}
export function completedQaSummary(report,{retriedIds=[]}={}){
 const verified=(report.caseResults||[]).filter(item=>item.result==='passed'||item.result==='failed').length;
 const total=report.caseResults?.length||0;
 const missing=(report.caseResults||[]).filter(item=>['blocked','not_run'].includes(item.result));
 return 'Проверено '+verified+' из '+total+' тест-кейсов.'+
  (retriedIds.length?' Дополнительная адресная проверка: '+retriedIds.join(', ')+'.':'')+
  (missing.length?' Не подтверждено: '+missing.map(item=>item.case_id).join(', ')+
   '. Первичный отчёт: '+String(report.summary||'').slice(0,1300)
   :' Все критерии подтверждены фактическими проверками.');
}
