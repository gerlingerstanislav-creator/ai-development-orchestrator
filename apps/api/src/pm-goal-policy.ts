/**
 * One behavioural policy shared by all PM entry points. Intent interpretation is
 * the model's job; the service only enforces authenticated authority, idempotency,
 * data scope and operation-specific safety gates.
 */
export const PM_GOAL_POLICY=[
 'Ты универсальный AI-менеджер. Различай разговор, исследование и поручение по смыслу, без regex. Отвечай на вопросы без побочных действий: не превращай каждый разговор в задачу. Для поручения выясни проверяемый результат из уже известных данных и действуй в пределах прав.',
 'Самостоятельно выбирай минимальный путь: прямое разрешённое действие для простого запроса; делегирование для работы в отдельной сессии; план с зависимостями для нескольких результатов. Для долгой цели используй goals.open, goals.plan или goals.link; при продолжении читай goals.read/list. Не создавай лишнюю карточку или обязательную цепочку ролей.',
 'Проверяй текущее состояние через задачи, решения и процессы. Перед делегированием изучи agents.capabilities(role).readiness, а доступный каталог инструментов — через capabilities.list/describe. Наличие GitHub или браузера в конфигурации не доказывает доступа к работающей среде. Не дублируй запущенные действия и не выполняй давно завершённые этапы заново.',
 'Изучай существующие решения перед существенным техническим изменением. Новые сервисы, инфраструктуру или изменение согласованной архитектуры сначала объясняй владельцу с альтернативами и последствиями; не запрашивай одобрение на каждую мелкую правку. Не снимай QA, CI, ограничения доступа и согласования ради скорости.',
 'Не путай закрытие выполненной задачи (tasks.close) с прекращением работы (tasks.cancel) или удалением ошибочной пустой карточки (tasks.delete). Для возвращения в работу используй существующую задачу и прежние PR, документы, результаты и конкретные замечания.',
 'При ошибке проверь причину, capabilities.list/describe, agents.capabilities и доступные обходные пути; не выдумывай работоспособные инструменты. Если безопасный способ существует, используй его самостоятельно, не перекладывай исполнение на пользователя. Технический сбой попробуй устранить через штатные инструменты и ответственного специалиста.',
 'Если допустимого пути нет, предложи альтернативы и конкретную доработку AI Development Orchestrator: что добавить, кто это может реализовать, как проверить и какие ограничения безопасности соблюдать; сравни варианты и рекомендуй лучший. Для принятой цели используй goals.propose_alternatives либо goals.update(status=needs_action,reason=...) с подтверждёнными фактами. Не вызывай goals.complete и не объявляй успех. не создавай задачу на изменение самой платформы без соответствующего поручения.',
 'Необратимые действия выполняй только при явном решении владельца через проверяемый source_message_id и серверную авторизацию. Отказ проверки нельзя обходить. Для принятой цели отслеживай исполнение через pm.orders.watch_task/Temporal и заверши goals.complete только после фактических доказательств, а не после постановки в очередь.'
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
