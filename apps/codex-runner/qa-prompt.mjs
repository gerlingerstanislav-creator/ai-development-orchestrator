import {assembleAgentPrompt} from '../api/src/prompt-assembler.mjs';

const limited=(text,n)=>String(text||'').trim().slice(0,n);
const runtimeSummary=(caps,baseline,browserEvidence,prerequisite)=>[
 'Реально обнаруженные возможности: '+limited(caps,450),
 browserEvidence?'Начальная проверка браузера: '+limited(browserEvidence,450):'',
 prerequisite?'Ограничение изоляции: '+limited(prerequisite,350):'',
 baseline?.length?'Проверки Runner: '+JSON.stringify(baseline.slice(0,3).map(b=>({
  name:b.name,command:b.command,exitCode:b.exitCode,output:limited(b.output,360)
 }))):''
].filter(Boolean).join('\n');

export function buildQaPrompt(job,{singlePass=false,adHoc=false,browserAvailable=false,
 browserStartupEvidence='',capabilities='',baseline=[],prerequisite='',testedCommit=''}={}){
 const base=job.agentPromptZones||{
  identity:'Независимый QA-инженер',
  objective:job.title+'\n'+limited(job.description,6500),
  context:limited(job.agentPrompt||job.handoffContext,2200),
  scope:job.repository+'; task '+job.taskId
 };
 const tools=[
  'Репозиторий доступен для чтения и запуска тестов без записи в GitHub. MCP orchestrator: tasks.read, knowledge.search/section, agents.consult, blockers.list/report/resolve.',
  'Справочник команд и ограничений: .ado-qa-tools.md — читай только нужные разделы.',
  'Запись подтверждений: node /opt/codex-runner/qa-exec.mjs case CASE_ID -- КОМАНДА.',
  browserAvailable
   ?'Визуальные проверки: node /opt/codex-runner/browser-client.mjs start; node /opt/codex-runner/browser-client.mjs assert --case CASE_ID "JS-условие".'
   :'Браузерный сервис недоступен. Не объявляй визуальные проверки успешными.',
  'План: .ado-qa-plan.json; схема ответа проверяется самим Runner.'
 ].join('\n');
 const protocol=[
  'Сначала прочитай актуальное состояние задачи через orchestrator.tasks.read; затем выполни доступные проверки требований и предъяви реальные доказательства по каждому кейсу. Для каждого подтверждённого результата необходима запись выполнения команды или браузерный assert с тем же case_id.',
  adHoc?'Тест-план пуст: самостоятельно выбери до 20 проверок по ТЗ, используй ID qa-1, qa-2 и т.д. и понятные названия.':'Прочитай .ado-qa-plan.json и обработай каждый case_id из плана.',
  'Пройденные проверки прежнего запуска можно учитывать только если подтверждён тот же SHA, требования не изменились и есть проверяемые доказательства; иначе перепроверь.',
  'Невозможность проверки означает blocked/not_run, не passed. Ошибка инструмента или установки зависимостей не является дефектом приложения. Реально воспроизводимый дефект — failed.',
  browserAvailable?'Если Chromium не открыл страницу при подготовке, сделай одну обоснованную повторную попытку после проверки пути/сборки; затем зафиксируй заблокированные браузерные кейсы.':'Проводи невизуальные проверки, не устанавливай отдельный Chromium в sandbox.'
 ].join('\n');
 const output=[
  'Ответ — строго JSON по --output-schema без Markdown.',
  'verdict: passed (все необходимые проверки подтверждены), failed (есть воспроизводимый дефект) или blocked (часть необходимого не проверена).',
  'caseResults: case_id, result, reason, evidence, command;'+(adHoc?' для каждого ещё title;':''),
  'checks: name, result, details, evidenceId, command. При отсутствии запуска command и evidenceId — пустые строки.',
  'reason: executed только для проверенных passed/failed; иначе tool_unavailable, environment_unavailable, manual_only или unknown.',
  'findings содержит только подтверждённые дефекты. summary и handoffNote кратко понятным языком; learningSuggestion — один подтверждённый вывод или пустая строка. Число тестов подсчитает Runner.'
 ].join('\n');
 const scope=[limited(base.scope,800),testedCommit?'Проверяемый SHA: '+testedCommit:''].filter(Boolean).join('\n');
 return assembleAgentPrompt({
  identity:base.identity,
  objective:base.objective,
  scope,
  policy:'Не публикуй изменения, не читай секреты, не отключай проверки. Запрещено самостоятельно разрешать слияние PR или признавать неисполненные кейсы успешными.',
  tools,
  protocol,
  output,
  runtime:runtimeSummary(capabilities,baseline,browserStartupEvidence,prerequisite),
  context:limited(base.context,2200),
  ruleIds:[
   {id:'qa.evidence',zone:'protocol'},
   {id:'qa.verdict',zone:'output'},
   {id:'qa.browser',zone:'tools'},
   {id:'qa.baseline',zone:'runtime'}
  ],
  budget:11000
 });
}
