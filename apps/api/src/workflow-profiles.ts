import type {Pool} from 'pg';

export const workflowProfiles = [
 {
  id:'fast',label:'Быстрый',audience:'Мелкие исправления и локальные улучшения',
  summary:'Короткий анализ и адресная QA-проверка. Доказательства, PR, CI и качество обязательны.',
  analysis:'Уточни только блокирующие неопределённости, сохрани проверяемые критерии. Не расширяй задачу ради формального документа.',
  testing:'Сфокусируй проверку на изменённых сценариях, критериях и необходимой регрессии. Не называй непроверенное успешным.',
  development:'Минимальное изолированное изменение, тесты затронутой функциональности, проверяемый PR. Не сокращай обязательные проверки.',
  steps:[
   {stage:'backlog',owner:'manager',participants:[],outcome:'Постановка и ожидаемое поведение определены'},
   {stage:'analysis',owner:'analysis',participants:['manager'],outcome:'Краткие критерии и вопросы закрыты'},
   {stage:'development',owner:'development',participants:['architect'],outcome:'Код, тесты и PR готовы'},
   {stage:'testing',owner:'testing',participants:['development'],outcome:'Целевые проверки и регрессия подтверждены'},
   {stage:'merge_queue',owner:'platform',participants:['architect'],outcome:'CI и ревью пройдены, PR слит'},
   {stage:'deployment',owner:'devops',participants:[],outcome:'Выкладка подтверждена или пропуск обоснован'},
   {stage:'documentation',owner:'documentation',participants:['analysis'],outcome:'Изменения задокументированы при необходимости'},
   {stage:'done',owner:'manager',participants:[],outcome:'Результат сохранён'}
  ]
 },
 {
  id:'standard',label:'Стандартный',audience:'Большинство задач (по умолчанию)',
  summary:'Анализ → разработка → ревью и CI → QA → слияние PR → выкладка → документация → готово.',
  analysis:'Сформируй требования, критерии приёмки, границы и зависимости. Передай разработчику самостоятельную постановку.',
  testing:'Покрой позитивные, негативные и граничные сценарии. Подтверди затронутую регрессию доказательствами.',
  development:'Реализуй требования, добавь тесты, создай PR, исправь замечания ревью и QA в той же ветке.',
  steps:[
   {stage:'backlog',owner:'manager',participants:[],outcome:'Цель и приоритет определены'},
   {stage:'analysis',owner:'analysis',participants:['manager','architect'],outcome:'ТЗ, критерии и зависимости готовы'},
   {stage:'development',owner:'development',participants:['architect','testing'],outcome:'Код, PR, проверки и ревью готовы'},
   {stage:'testing',owner:'testing',participants:['development','analysis'],outcome:'Критерии подтверждены или дефекты возвращены'},
   {stage:'merge_queue',owner:'platform',participants:['architect'],outcome:'Проверки текущего SHA пройдены, PR слит'},
   {stage:'deployment',owner:'devops',participants:['testing'],outcome:'Релиз подтверждён или пропуск зафиксирован'},
   {stage:'documentation',owner:'documentation',participants:['analysis','development'],outcome:'Документация обновлена по фактическим изменениям'},
   {stage:'done',owner:'manager',participants:[],outcome:'Артефакты и результат зафиксированы'}
  ]
 },
 {
  id:'extended',label:'Расширенный',audience:'Сложные интеграции и высокие риски',
  summary:'Углублённый анализ, архитектурные риски, расширенная регрессия, контролируемая выкладка и план восстановления.',
  analysis:'Укажи риски, альтернативы, несовместимые изменения, миграции и план отката. Неоднозначные продуктовые решения согласуй.',
  testing:'Проверь негативные и крайние сценарии, интеграции, регрессию, безопасность и восстановление, когда применимо. Не придумывай требований.',
  development:'Зафиксируй архитектурные последствия, совместимость и план миграции/отката. Проверь сложные случаи до QA.',
  steps:[
   {stage:'backlog',owner:'manager',participants:['architect'],outcome:'Область и риски изменения оценены'},
   {stage:'analysis',owner:'analysis',participants:['architect','manager','testing'],outcome:'Согласованы требования, риски и критерии'},
   {stage:'development',owner:'development',participants:['architect','testing','devops'],outcome:'Код, тесты, PR, техрешения и откат готовы'},
   {stage:'testing',owner:'testing',participants:['analysis','development','architect'],outcome:'Расширенная QA и регрессия подтверждены'},
   {stage:'merge_queue',owner:'platform',participants:['architect','manager'],outcome:'CI, независимое ревью и QA соблюдены'},
   {stage:'deployment',owner:'devops',participants:['testing','development','manager'],outcome:'Контролируемый релиз и smoke или явный пропуск'},
   {stage:'documentation',owner:'documentation',participants:['analysis','architect','development'],outcome:'Архитектура и эксплуатация обновлены'},
   {stage:'done',owner:'manager',participants:['testing'],outcome:'Риски и результат закрыты'}
  ]
 }
] as const;

export type WorkflowProfile=(typeof workflowProfiles)[number]['id'];
export function isWorkflowProfile(value:unknown):value is WorkflowProfile {
 return typeof value==='string'&&workflowProfiles.some(profile=>profile.id===value);
}
export function workflowProfile(value:unknown){
 return workflowProfiles.find(profile=>profile.id===value)??workflowProfiles[1];
}
export function workflowProfileInstructions(profile:WorkflowProfile,stage:string):string {
 const definition=workflowProfile(profile);
 if(stage==='analysis')return definition.analysis;
 if(stage==='development')return definition.development;
 if(stage==='testing')return definition.testing;
 return definition.steps.find(step=>step.stage===stage)?.outcome??'';
}
/** A task snapshots its profile on creation; changing the project default cannot re-scope running tasks. */
export async function readTaskWorkflowProfile(db:Pick<Pool,'query'>,projectId:string,taskId:string):Promise<WorkflowProfile>{
 try{
  const result=await db.query('SELECT workflow_profile FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]);
  return isWorkflowProfile(result.rows[0]?.workflow_profile)?result.rows[0].workflow_profile:'standard';
 }catch(error){
  if(String((error as {code?:string}).code)==='42703')return 'standard';
  throw error;
 }
}
export function profileCanChange(stage:string,analysisState:string|null,hasPr:boolean):boolean {
 return (stage==='backlog'||stage==='analysis')&&analysisState!=='processing'&&!hasPr;
}
