import {assembleAgentPrompt} from '../api/src/prompt-assembler.mjs';
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
 const isVisual=item=>{
  const spec=byId.get(item.case_id)||{};
  const label=[spec.title,item.title,spec.description,spec.area,...(spec.steps||[]).flatMap(step=>[step.action,step.expected])].join(' ');
  return /(визуальн|отображен|выгляд|интерфейс|кнопк|расположен|окружност|стрелк|фигур|цвет|адаптив|скриншот|браузер|отрисов|верстк|перекрыв|размер(?:а|ов)? экрана|ui\b|css\b|canvas|svg|pixel|layout|render|click|responsive|screenshot|viewport)/i.test(label);
 };
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
export function qaCompletionPrompt(cases,{taskTitle='',taskDescription=''}={}){
 return assembleAgentPrompt({
  identity:'Независимый QA-специалист, допроверяющий недостающие кейсы',
  objective:'Адресно проверь только перечисленные критерии приёмки на том же SHA. '+String(taskTitle).slice(0,180)+
   '\n'+String(taskDescription).slice(0,800)+'\nКейсы и ожидаемые результаты:\n'+JSON.stringify(cases),
  scope:'Та же временная копия проекта и уже созданная защищённая браузерная сессия.',
  policy:'Не меняй код, не создавай PR и не выдумывай результаты. Не объявляй выполненным ничего, для чего нет фактического доказательства.',
  tools:'Для визуального критерия: node /opt/codex-runner/browser-client.mjs assert --case CASE_ID "JS-условие". Для команды: node /opt/codex-runner/qa-exec.mjs case CASE_ID -- КОМАНДА. При необходимости browser-client.mjs start/goto/viewport.',
  protocol:'Выполняй отдельное утверждение для каждого case_id: не переноси доказательства другого кейса. Сверяй именно ожидаемое поведение, а не выражение true. Браузерный сбой фиксируй точно; не повторяй всю регрессию. Runner сверит браузерные assertions и командные receipts.',
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
