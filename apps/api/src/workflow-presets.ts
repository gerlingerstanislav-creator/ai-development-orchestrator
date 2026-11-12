/**
 * Profiles describe how much planning and coordination a task needs.
 * They NEVER waive immutable analysis, QA, review, CI, merge or deployment
 * evidence gates. Stage ownership and execution remain with Temporal.
 */
export const DEFAULT_WORKFLOW_PRESET = 'standard' as const;
export type WorkflowPresetId = 'fast'|'standard'|'extended';
export type WorkflowPreset = {
 id:WorkflowPresetId;
 title:string;
 usage:string;
 description:string;
 planning:string;
};
export const WORKFLOW_PRESETS:readonly WorkflowPreset[] = [
 {
  id:'fast',title:'Быстрый',usage:'Локальные исправления, небольшой объём и низкий риск',
  description:'Краткий анализ, один набор критериев приёмки, реализация и адресные проверки.',
  planning:'Не создавай лишние документы и согласования. Зафиксируй критерии приёмки, сохрани независимый QA и проверки PR. Пропуск выкладки допускается только по настройкам окружения.'
 },
 {
  id:'standard',title:'Стандартный',usage:'Основной сценарий для большинства продуктовых задач',
  description:'Анализ → планирование → разработка → QA → слияние PR → выкладка → документация.',
  planning:'Уточни функциональные и нефункциональные требования, зависимости, тест-кейсы и сценарий выкладки. PM согласует только значимые продуктовые решения.'
 },
 {
  id:'extended',title:'Расширенный',usage:'Архитектурные изменения, миграции, платежи и высокие риски',
  description:'Подробный анализ рисков, архитектурная оценка, расширенная QA-матрица и проверяемый релиз.',
  planning:'Добавь архитектурные альтернативы, риски, миграции, обратную совместимость, безопасность, регрессию, план отката и необходимые согласования владельца.'
 }
] as const;
export const WORKFLOW_STAGE_SEQUENCE = [
 'backlog','analysis','development','testing','merge_queue','deployment','documentation','done'
] as const;
export function workflowPreset(id:unknown):WorkflowPreset {
 return WORKFLOW_PRESETS.find(profile=>profile.id===id)??WORKFLOW_PRESETS[1];
}
export function workflowPlanningContext(id:unknown):string {
 const profile=workflowPreset(id);
 return 'Профиль сложности: '+profile.title+'. '+profile.planning+' Обязательные автоматические проверки, подтверждение анализа, независимая QA, ревью, CI и условия слияния PR не отменяются профилем.';
}
