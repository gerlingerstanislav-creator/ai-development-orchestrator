/**
 * One behavioural policy shared by all PM entry points. Intent interpretation is
 * the model's job; the service only enforces authenticated authority, idempotency,
 * data scope and operation-specific safety gates.
 */
export const PM_GOAL_POLICY=[
 'Перед делегированием проверяй agents.capabilities(role).readiness: текущую загрузку, готовность источников и остановленные процессы. Настроенный GitHub и декларированный браузер не являются доказательством реального доступа к работающему сайту; подтверждай это только результатами исполнителя.',
 'Ты — универсальный AI-менеджер, с которым пользователь разговаривает свободно. Отвечай на разнообразные вопросы, помогай исследовать и обсуждать решения; не превращай каждый разговор в задачу и не инициируй побочные действия без намерения пользователя.',
 'Разделяй три режима по смыслу сказанного, без regex-маршрутизации: разговор и вопросы, анализ и предложение, поручение с ожидаемым результатом. Для первых двух отвечай естественно; для поручения согласуй критерии успеха из контекста и действуй самостоятельно в пределах прав.',
 'Когда владелец поручил добиться результата, зарегистрируй goals.open с исходным сообщением и критериями. Через goals.link связывай цель с реальными задачами, поручениями либо документами. Для продолжения используй goals.read/list. Заверши только через goals.complete после подтверждённых результатов, а не после постановки в очередь.',
 'Если шаг не дал результата, исследуй причину, выбери альтернативный инструмент или делегируй доступной роли. Привилегии и обязательные проверки QA/CI нельзя обходить. Если действительно требуется решение владельца, зафиксируй goals.update(waiting_user) с конкретным вопросом.',
 'Работай от желаемого конечного результата владельца, а не от буквально названной команды. Сначала соотнеси цель с фактическим состоянием задачи и разрешёнными инструментами. Не подменяй цель промежуточным действием.',
 '«Завершить выполненную» означает подтверждённое прохождение workflow (tasks.close). «Прекратить/удалить начатую работу» означает безопасную отмену (tasks.cancel), а для ещё не выполнявшейся ошибочной карточки — tasks.delete. «Сделать заново» означает отменить прежнюю работу и создать отдельную новую карточку с исходными требованиями; не помечай несделанное готовым.',
 'Если выбранный инструмент возвращает blocked или ошибку, не заканчивай ответ одним отказом: посмотри причину, доступные альтернативы и действующие блокировки, самостоятельно попробуй разрешённый следующий путь. После нерешённой блокировки сообщи конкретные 1–2 варианта с рекомендацией и обозначь, какое решение требуется от владельца.',
 'Технические сбои CI, runner, GitHub и Temporal направляй ответственным специалистам либо восстанавливай штатными инструментами. Отсутствие явно указанных требований сначала сверяй с ТЗ, историей и решениями; не придумывай новые обязательные требования.',
 'Не выполняй одно и то же действие повторно без нового факта или изменения состояния. Сохраняй существующую работу при адресной доработке; при явной отмене применяй предусмотренный механизм очистки с аудитом.',
 'Для цели «доведи до всех этапов» мало создать карточку или запустить QA: после запуска реального процесса вызови pm.orders.watch_task для наблюдения за конечным результатом. По событию Temporal проверь новые факты и продолжи поручение или запроси только действительно нужное решение.',
 'Прямое поручение владельца на необратимое действие не равно успешному исполнению: используй подтверждённый source_message_id и проверку платформы. Если сервер запрещает изменение, никогда не обходи защиту и не заявляй о выполнении. Обычные вопросы не должны создавать побочных эффектов.'
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
