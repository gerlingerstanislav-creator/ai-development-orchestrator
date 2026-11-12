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
  return /(визуальн|отображен|выгляд|интерфейс|кнопк|расположен|окружност|стрелк|фигур|цвет|адаптив|скриншот|браузер|отрисов|верстк|перекрыв|размер(?:а|ов)? экрана|ui\\b|css\\b|canvas|svg|pixel|layout|render|click|responsive|screenshot|viewport)/i.test(label);
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
 return [
  'Ты QA-специалист. Первичная проверка завершилась, но некоторые критерии приёмки остались без подтверждения. Это адресная ДОПРОВЕРКА того же коммита, а не повторная реализация задачи.',
  'Ты работаешь в той же временной копии проекта; защищённая browser-сессия уже создана. Используй только существующие инструменты и реальную проверку, не изменяй код, не создавай PR.',
  'Недостающие кейсы, которые необходимо проверить отдельно ПО ИХ ID: '+JSON.stringify(cases),
  'Каждому визуальному критерию нужна отдельная фактическая команда: node /opt/codex-runner/browser-client.mjs assert --case CASE_ID "JS-условие, проверяющее ожидаемый результат". CASE_ID строго совпадает с ID из списка.',
  'Если браузер ещё не открыт, сначала запусти node /opt/codex-runner/browser-client.mjs start (или start /путь.html). После этого можешь выполнить goto и viewport. Убедись, что выражение проверяет именно содержание кейса: количество элементов, computed styles, геометрию или видимость. Одно лишь выражение true не является предметной проверкой.',
  'Для структурных/командных критериев при необходимости используй node /opt/codex-runner/qa-exec.mjs case CASE_ID -- КОМАНДА. Отчёты и npm test без привязки к CASE_ID сами по себе не доказывают выполнение именно этого кейса.',
  'Не переиспользуй автоматически подтверждение другого case_id. Если два критерия пересекаются, реально выполни относящееся к каждому утверждение с его ID.',
  'Если браузер не работает, сообщи точную ошибку и не объявляй проверку пройденной. Предыдущие доказательства уже сохранены, не перечитывай все документы и не запускай заново всю регрессию.',
  'Задача: '+String(taskTitle).slice(0,180)+'. '+String(taskDescription).slice(0,1000),
  'В конце верни компактный JSON в установленном формате. Система самостоятельно сверит фактические browser assertions и qa-exec receipts; текст отчёта не засчитывается в доказательства.'
 ].join('\n\n');
}
export function completedQaSummary(report,{retriedIds=[]}={}){
 const verified=(report.caseResults||[]).filter(item=>item.result==='passed'||item.result==='failed').length;
 const total=report.caseResults?.length||0;
 const missing=(report.caseResults||[]).filter(item=>['blocked','not_run'].includes(item.result));
 return 'Проверено '+verified+' из '+total+' тест-кейсов.'+
  (retriedIds.length?' Дополнительная адресная проверка: '+retriedIds.join(', ')+'.':'')+
  (missing.length?' Не подтверждено: '+missing.map(item=>item.case_id).join(', ')+'.':' Все критерии подтверждены.')+
  ' '+String(report.summary||'').slice(0,1600);
}
