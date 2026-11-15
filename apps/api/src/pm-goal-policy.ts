/**
 * One behavioural policy shared by all PM entry points. Intent interpretation is
 * the model's job; the service only enforces authenticated authority, idempotency,
 * data scope and operation-specific safety gates.
 */
export const PM_GOAL_POLICY=[
 'Различай разговор, исследование и поручение. На вопрос отвечай без побочных действий: не превращай каждый разговор в задачу. Для задачи сохраняй проверяемый результат. Выбирай прямое разрешённое действие, одно делегирование либо план с реальными зависимостями. Для долгой цели используй goals.open, goals.plan или goals.link; не создавай фиктивный workflow.',
 'Если выполняешь поручение по КОНКРЕТНОЙ задаче, получи её состояние и контекст. Для действий на уровне проекта (снимки сайта, исследование исходников, документы) активная задача НЕ требуется и не создаётся. Инструменты ищи через capabilities.list/describe и agents.capabilities. При техническом отказе выясни причину и доступные обходные пути, не выдумывай работоспособные инструменты. Если безопасный путь есть, используй его самостоятельно, не перекладывай исполнение на пользователя.',
 'Необратимые действия требуют подтверждённого source_message_id и штатной авторизации. Не путай tasks.close, tasks.cancel и tasks.delete. Старые задачи ищи через tasks.list(display_number=N); не угадывай UUID. Не повторяй работу, сохраняй прежний PR, доказательства и историю.',
 'QA/CI/PR/выкладка обязательны для изменённого кода, если установлены правилами платформы. Для снимков КОНКРЕТНОЙ задачи ПМ может сам использовать browser.capture. Для изображений сайта ПРОЕКТА — browser.capture_project (mode=full_page или all_pages), независимо от завершённых/отложенных задач, без делегирования и QA. «Тестовое окружение» без явно указанного deployment URL означает локально собранную GitHub-версию проекта в изолированном браузере: не спрашивай адрес внешнего тестового сайта и не требуй deployment SHA от владельца, а используй source SHA локальной сборки. Только явно указанный опубликованный URL требует проверки deployment-версии. Не повторяй заведомо сломанный старый SHA: актуальный сайт проверяй по HEAD подключённой ветки; явно заданную историческую ревизию не подменяй. Не объявляй результат до подтверждения SHA и реальных изображений. work.artifacts проверяет артефакты задач, а browser.capture_project возвращает проверенные проектные снимки и автоматически прикрепляет их к сообщению.',
 'Когда доступного способа нет, предложи конкретную доработку AI Development Orchestrator: кто это может реализовать, как проверить и какие ограничения безопасности соблюдать. Сравни варианты и рекомендуй лучший. Для открытой цели используй goals.propose_alternatives либо goals.update(status=needs_action,reason=...), а не фиктивное выполнение. Не вызывай goals.complete без доказательств; не создавай задачу на изменение самой платформы без соответствующего поручения.',
 'Используй pm.orders.watch_task/Temporal для продолжения; постановка процесса в очередь — не конечный результат. goals.complete допускается только после проверки выполненной цели.'
].join('\n');

export type PmToolOutcome={status?:string;reason?:string;blockers?:unknown;[key:string]:unknown};
const alternatives:Record<string,readonly {tool:string;when:string}[]>={
 'tasks.delete':[
  {tool:'tasks.cancel',when:'Есть начатая разработка, QA или PR, а владелец хочет отказаться от старой работы'},
  {tool:'tasks.read',when:'Нужно проверить стадию и реальную историю работы'}
 ],
 'tasks.close':[
  {tool:'tasks.cancel',when:'Цель — прекратить незавершённую работу, а не признать её выполненной'},
  {tool:'workflow.move_task',when:'Цель — довести работу до готовности через доработку'},
  {tool:'qa.retry',when:'Работа завершена, но QA был заблокирован технической ошибкой'}
 ],
 'tasks.cancel':[
  {tool:'processes.list',when:'Отмена заблокирована активным процессом; уточни его жизненный цикл'},
  {tool:'tasks.read',when:'Есть зависимости, чужие артефакты либо уже слитый PR, которые нельзя автоматически очищать'}
 ],
 'qa.retry':[
  {tool:'processes.list',when:'Проверь конкретный сбой, SHA и активные исполнения'},
  {tool:'workflow.move_task',when:'Нужны реальные исправления разработки или уточнение требований'}
 ],
 'workflow.move_task':[
  {tool:'tasks.read',when:'Проверь актуальную стадию и право перехода'},
  {tool:'blockers.list',when:'Проверь конкретные ограничения задачи'}
 ]
};
export function annotatePmToolResult(name:string,result:unknown){
 if(!result||typeof result!=='object'||Array.isArray(result))return result;
 const state=result as PmToolOutcome;
 if(state.status!=='blocked')return result;
 return {...state,goal_reached:false,
  alternatives:alternatives[name]||[
   {tool:'capabilities.list',when:'Найди безопасную альтернативу внутри имеющихся полномочий'}
  ],
  guidance:'Текущий способ не сработал. Выбери допустимый следующий путь достижения цели или предложи владельцу конкретные варианты; не сообщай просто об отказе.'};
}
export function pmOrderStateFromResults(results:readonly {tool:string;result:unknown}[],watchCount:number,ownerQuestion=false):'waiting_agents'|'waiting_user'|'working'|'completed'{
 if(ownerQuestion)return 'waiting_user';
 if(watchCount)return 'waiting_agents';
 // The last meaningful operation determines the outcome: an earlier blocked
 // delete followed by a successful cancellation must not leave the order blocked.
 const actionable=results.filter(item=>!['pm.orders.update','processes.report','memory.record'].includes(item.tool));
 const last=actionable.at(-1)?.result as PmToolOutcome|null;
 const unresolved=last&&typeof last==='object'&&['blocked','needs_action'].includes(String(last.status||''));
 return unresolved?'waiting_user':'completed';
}
