/**
 * Pure policy decision: skipped deployment is not a successful deployment.
 * Unknown modes fail closed instead of silently bypassing the gate.
 */
export function deploymentDecision(mode:unknown):{stage:'documentation'|'deployment';status:'skipped'|'pending';reason:string}{
 if(mode==='skip')return {
  stage:'documentation',status:'skipped',
  reason:'Нет настроенного окружения: этап выкладки пропущен согласно настройкам проекта'
 };
 if(mode==='manual'||mode==='automatic')return {
  stage:'deployment',status:'pending',
  reason:mode==='automatic'?'Ожидание проверяемой автоматической выкладки':'Ожидание подтверждённой ручной выкладки'
 };
 throw new Error('Неизвестный режим выкладки: действие заблокировано');
}
