import {assembleAgentPrompt} from '../api/src/prompt-assembler.mjs';
const clip=(s,n)=>String(s||'').trim().slice(0,n);

export function buildDeveloperPrompt(job){
 const base=job.agentPromptZones||{
  identity:job.agentName||'AI-разработчик',
  objective:job.title+'\n'+clip(job.description,9800),
  context:clip(job.agentPrompt||job.handoffContext,2500),
  scope:'Репозиторий '+job.repository+'; базовая ветка '+job.baseBranch+'; задача '+job.taskId
 };
 return assembleAgentPrompt({
  identity:base.identity,
  objective:base.objective,
  scope:clip(base.scope,900),
  policy:'Не читай и не изменяй секреты, .env, credentials или настройки доступа. Не выполняй git push/commit/checkout; публикация и PR — только ответственность Runner. Не редактируй файлы вне локального репозитория и не устанавливай сетевые пакеты.',
  tools:[
   'Редактирование и проверка файлов локальной рабочей копии; терминал и тесты.',
   'MCP orchestrator: tasks.read, knowledge.search/section, processes.list, agents.consult и blockers.list/report/resolve.',
   'Общение со специалистами — только через сообщения и историю текущей задачи.',
   clip(base.tools,650)
  ].filter(Boolean).join('\n'),
  protocol:[
   'Сначала вызови orchestrator.tasks.read для актуального состояния. Осмотри текущие исходники, имеющийся PR и фактические критерии. Самостоятельно выбери необходимое действие: исправить код, продолжить прежнюю ветку или доказать, что задача уже реализована.',
   'Если код нужен — внеси изменения в рабочую копию и проверь затронутую функциональность. Если нет исходников — создай необходимые файлы. Ненужные изменения ради коммита запрещены.',
   job.reworkFeedback?'Это возврат с QA. Если фактически исправлять нечего, не меняй файлы и обязательно напиши проверяемое объяснение для QA с привязкой к исходникам и конкретным замечаниям. Верни задачу на повторный QA того же PR и SHA; не утверждай, что QA уже пройден.':'',
   'При техническом блокере изучи имеющиеся документы, при необходимости обратись к специалисту через инструменты задачи; зафиксируй доказанный блокер.'
  ].join('\n'),
  output:[
   'Если код уже полностью есть в базовой ветке без правок: строка RESULT: already_implemented и отдельная строка IMPLEMENTATION_EVIDENCE: {"summary":"не менее 40 символов","files":["реальный/путь"],"criteria":["требование и проверяемое обоснование"]}. QA проверит независимо.',
   'В иных случаях оставь изменённые файлы локально; commit, push и PR выполнит Runner.',
   'В конце HANDOFF_NOTE: 1–3 коротких предложения для истории задачи или none; LEARNING_SUGGESTION: один полезный вывод из фактов или none.'
  ].join('\n'),
  context:clip(base.context,2400),
  ruleIds:[{id:'dev.git',zone:'protocol'},{id:'dev.existing',zone:'output'}],
  budget:15000
 });
}
