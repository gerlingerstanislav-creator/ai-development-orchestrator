import type {Pool} from 'pg';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {agentMemoryContext} from './agent-memory.js';
import {normalizeTaskToolGrants} from './modules/agents/domain/tool-capabilities.js';

export const hashSecret=(text:string)=>createHash('sha256').update(text).digest('hex');
const field=(type:string,description:string)=>({type,description});
const readOnlyTools=new Set(['project.context','documents.list','documents.read','documents.search',
 'pm.decisions.list','pm.orders.list','iterations.preview_plan','approvals.list','discussions.list',
 'tasks.list','tasks.read','tasks.history','tasks.dependency_graph','tasks.request_owner_question_cleanup','questions.list','processes.list','blockers.list','memory.list','documentation.request_reset',
 'history.search','discussions.read','agents.capabilities','work.list','work.artifacts','capabilities.list','capabilities.describe','instructions.reconcile','iterations.list','iterations.read','knowledge.search','knowledge.read','knowledge.related','knowledge.context','knowledge.section','knowledge.sections','project.source']);
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[])=>({
 name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
 annotations:readOnlyTools.has(name)
  ?{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  :{readOnlyHint:false}
});
const id=field('string','UUID'),str=field('string','Произвольный текст');
const idem=field('string','Необязательный стабильный ключ идемпотентности для безопасных повторов');
export const agentToolCatalog=[
 tool('project.context','Получить информацию о проекте, правила, workflow, GitHub и инструкции.',{}),
 tool('project.source','Исследовать исходники подключённого GitHub-репозитория. Без path вернуть список файлов и закреплённый SHA; с path прочитать выбранный файл с того же SHA. Выбирай файлы самостоятельно по цели исследования.',{path:str,commit:str}),
 tool('agents.capabilities','Посмотреть доступные инструменты, компетенции и ограничения выбранного специалиста до делегирования.',{role:{type:'string',enum:['analysis','development','testing','documentation','devops','architect']}},['role']),
 tool('capabilities.list','Краткий каталог разрешённых действий с категориями и побочными эффектами.',{category:field('string','Необязательный префикс категории')}),
 tool('capabilities.describe','Подробный контракт разрешённого инструмента, его параметры и ограничения.',{name:str},['name']),
 tool('instructions.reconcile','Проверить новое правило на дубли и возможные конфликты с правилами адресатов. Не меняет инструкции.',{target_roles:{type:'array',items:{type:'string',enum:['manager','analyst','analysis','development','testing','documentation','devops','architect']}},text:str,applicability:{type:'object',properties:{technology:str,repository:str,task_type:str},additionalProperties:false}},['target_roles','text']),
 tool('instructions.propose','ПМ: распределить постоянное правило по ролям. При дословном подтверждённом указании владельца без пересечений правило применяется сразу; иначе отправляется на согласование в Команду.',{target_roles:{type:'array',items:{type:'string',enum:['manager','analyst','analysis','development','testing','documentation','devops','architect']}},text:str,source_message_id:id,applicability:{type:'object',properties:{technology:str,repository:str,task_type:str},additionalProperties:false},reason:str,supersedes_id:id,idempotency_key:idem},['target_roles','text']),
 tool('pm.decisions.list','Прочитать структурированные решения владельца, чтобы не задавать повторных вопросов.',{}),
 tool('pm.decisions.record','Зафиксировать ответ владельца в реестре решений. Укажи ID его исходного сообщения. При наличии итерации решение передаётся СА.',{source_message_id:id,question:str,answer:str,iteration_id:id,order_id:id},['source_message_id','question','answer']),
 tool('pm.orders.list','Просмотреть активные поручения ПМ и их статусы.',{}),
 tool('pm.orders.watch_task','Отслеживать цель провести существующую задачу через все этапы до done. Регистрируй после запуска реальной работы; если работы нет, инструмент вернёт needs_action и предложит продолжить workflow, а не выдаст запуск за завершение.',{task_id:id,idempotency_key:idem},['task_id']),
 tool('pm.orders.update','Зафиксировать состояние поручения: ждать ответа владельца, ждать агента, завершить или отметить ошибку.',{order_id:id,status:{type:'string',enum:['working','waiting_agents','waiting_user','completed','failed']},summary:str},['order_id','status']),
 tool('iterations.ask_question','Добавить вопрос к итерации, требующий решения владельца. Вопрос показывается на вкладке План разработки.',{iteration_id:id,question:str},['iteration_id','question']),
 tool('iterations.record_decision','Записать ответ владельца на вопрос аналитика по итерации. Ответ попадёт в следующие попытки декомпозиции и не будет утерян.',{iteration_id:id,question:str,answer:str},['iteration_id','question','answer']),
 tool('iterations.approve','Согласовать редакцию объёма итерации после явного подтверждения владельца. Нужна текущая revision.',{iteration_id:id,expected_revision:field('integer','Текущая ревизия объёма')},['iteration_id','expected_revision']),
 tool('iterations.preview_plan','Посмотреть состав плана, публикацию и отличия от существующих карточек. Новые задачи согласованной итерации появляются на доске автоматически после подготовки; повторное подтверждение для них не нужно.',{iteration_id:id,plan_id:id},['iteration_id','plan_id']),
 tool('iterations.publish_plan','Применить явно подтверждённые ИЗМЕНЕНИЯ существующих карточек. Новые задачи публикуются автоматически по завершении подготовки согласованной итерации; повторно публикацию не запускай. Передавай preview_revision и выбранные ключи существующих изменений.',{iteration_id:id,plan_id:id,preview_revision:str,selected_changes:{type:'array',items:str}},['iteration_id','plan_id','preview_revision','selected_changes']),
 tool('iterations.list','Найти итерации в разделе «План разработки».',{}),
 tool('iterations.read','Прочитать объём итерации, ссылки на документы, текущие задачи и ревизии.',{iteration_id:id},['iteration_id']),
 tool('iterations.save','По явной просьбе сохрани согласованное в обсуждении описание как черновик итерации. Для обновления передай ID текущей итерации. Сохраняй цель, границы, критерии готовности и исходные страницы.',
  {iteration_id:id,expected_revision:field('integer','Текущая ревизия'),title:str,body:str,document_ids:{type:'array',items:id},idempotency_key:idem},['title','body']),
 tool('iterations.prepare_plan','Передать текущий объём аналитику. Он создаёт или обновляет карточки из плана; готовые задачи автоматически уходят в очередь разработки.',
  {iteration_id:id,request:field('string','Уточнение владельца к декомпозиции в границах согласованного объёма'),idempotency_key:idem},['iteration_id']),
 tool('iterations.launch','Ручной запуск итерации по явной просьбе владельца. Готовые задачи обычно запускаются автоматически, проверь очередь перед повторной попыткой.',{iteration_id:id,expected_revision:field('integer','Согласованная текущая ревизия итерации'),idempotency_key:idem},['iteration_id','expected_revision']),
 tool('iterations.recommend_launch','Сохранить предлагаемый пакет до пяти задач в порядке запуска для выбора владельцем. Вызов не запускает разработку.',
  {iteration_id:id,task_ids:{type:'array',items:id},idempotency_key:idem},['iteration_id','task_ids']),
 tool('documents.list','Показать дерево документации с ревизиями. Перед созданием страниц ознакомься с существующей структурой, вложенные разделы определяются агентами.',{}),
 tool('documents.read','Прочитать полную страницу и получить revision.',{document_id:id},['document_id']),
 tool('documents.search','Найти страницы по содержимому или названию.',{query:str},['query']),
 tool('documents.create','Создать страницу в выбранном существующем разделе. Прочитай дерево и проверь похожие страницы; при совпадении смысла обнови их вместо дублирования. Вложенную структуру выбирай по контексту проекта и практике подготовки ТЗ.',{title:str,body:str,parent_id:id,idempotency_key:idem},['title','body','parent_id']),
 tool('documents.update','Обновить содержимое, название или родителя страницы с проверкой revision. Системные корни можно наполнять, но нельзя переименовывать или переносить.',{document_id:id,expected_revision:str,title:str,body:str,parent_id:id,idempotency_key:idem},['document_id','expected_revision']),
 tool('documents.delete','Удалить пустую ненужную страницу после проверки revision. Только несистемная страница без детей, источников, истории и ссылок из задач; непустое содержимое сначала сохрани в других документах. Повторные удаления используй с idempotency_key.',{document_id:id,expected_revision:str,idempotency_key:idem},['document_id','expected_revision']),
  tool('documents.changeset','Атомарно применить список create/update/delete. Выбирай структуру по содержанию: один документ или несколько; переносы выполняй через update(parent_id), пустые заготовки удаляй после проверки.',{operations:{type:'array',items:{type:'object',properties:{op:field('string','create, update или delete'),document_id:id,expected_revision:str,title:str,body:str,parent_id:id},required:['op']}},idempotency_key:idem},['operations']),
 tool('knowledge.search','Поиск утверждённых проектных знаний по названию, тексту и метаданным. Верни сначала короткие результаты.',{query:str,limit:field('number','Максимум 20 результатов')},['query']),
 tool('knowledge.read','Адресно прочитать документ из базы знаний и записать использованную версию.',{document_id:id,mode:field('string','summary или full'),task_id:id},['document_id']),
 tool('knowledge.sections','Перечислить заголовки Markdown и получить стабильные UUID разделов без полного текста.',{document_id:id},['document_id']),
 tool('knowledge.section','Читать один Markdown-раздел по стабильному UUID из knowledge.sections; экономит контекст.',{document_id:id,section_id:field('string','UUID раздела из knowledge.sections'),task_id:id},['document_id','section_id']),
 tool('knowledge.related','Найти связанные требования и архитектурные документы.',{document_id:id},['document_id']),
 tool('knowledge.context','Получить минимальный обязательный контекст и релевантные документы для задачи.',{task_id:id,stage:str},['task_id']),
 tool('project.agents.start','Запустить специалистов выбранного проекта после остановки или новой выкладки по прямому поручению владельца; запланированные задачи продолжат обработку.',{}),
 tool('work.list','Прочитать поручения и доказательства по задаче, не подменяя ими статус самой задачи.',{task_id:id},['task_id']),
 tool('work.artifacts','Получить проверенные браузерные артефакты с SHA исходников, viewport, контрольной суммой и защищёнными ссылками на изображения.',{task_id:id},['task_id']),
 tool('work.plan','Составить произвольный проверяемый план из нескольких поручений с зависимостями. Зависимости задаются ключами шагов, не этапами Kanban. Все шаги и связи сохраняются атомарно; исполнители запускаются по мере завершения предусловий.',{
  task_id:id,
  steps:{type:'array',items:{type:'object',properties:{
   key:field('string','Короткий уникальный ключ шага, например prepare-env'),
   role:{type:'string',enum:['analysis','development','testing','documentation','devops','architect']},
   objective:field('string','Конкретная цель поручения'),
   acceptance:field('string','Проверяемые критерии результата'),
   needs:{type:'array',items:{type:'string'}},
   tools:{type:'array',items:{type:'string'},description:'Дополнительные безопасные инструменты именно для этого поручения; см. agents.capabilities'}
  },required:['key','role','objective','acceptance'],additionalProperties:false}},
  idempotency_key:idem
 },['task_id','steps']),
 tool('work.delegate','Поручить специалисту конкретную работу на основе цели, критериев приёмки и его инструментов. Без фиктивных PR и переходов Kanban; результат проверяет ПМ.',{task_id:id,role:{type:'string',enum:['analysis','development','testing','documentation','devops','architect']},objective:str,acceptance:str,tools:{type:'array',items:{type:'string'},description:'Дополнительные инструменты на срок активного поручения'},idempotency_key:idem},['task_id','role','objective','acceptance']),
 tool('work.report','Исполнитель: сообщить проверяемый результат или конкретную блокировку своего активного поручения. Сообщение не закрывает задачу; итог изучает ПМ.',{result:str,evidence:str,status:{type:'string',enum:['submitted','blocked']}},['result','evidence','status']),
 tool('work.review','ПМ: проверить результат или назначить повтор после блокировки. Принятие поручения не обходит QA/PR/выкладку и не переводит саму задачу в done.',{assignment_id:id,action:{type:'string',enum:['accept','retry','cancel']},reason:str,idempotency_key:idem},['assignment_id','action','reason']),
 tool('work.grant','ПМ: добавить конкретному незавершённому поручению необходимые безопасные инструменты. Заблокированная попытка сохраняется в истории и повторяется; полномочия выдаются только этому исполнителю и текущей версии задачи.',{assignment_id:id,tools:{type:'array',items:str},reason:str,idempotency_key:idem},['assignment_id','tools','reason']),
 tool('tasks.list','Получить все задачи и этапы; product_owner_questions_only=true показывает задачи с ожидаемыми ответами владельца, не перемещая их между этапами.',{product_owner_questions_only:field('boolean','Показать задачи с открытыми вопросами владельцу')}),
 tool('tasks.history','Постраничная полная история сообщений, событий и заметок задачи. Передавай cursor следующей страницы при необходимости.',{task_id:id,cursor:field('string','Курсор next_cursor из предыдущего ответа'),limit:field('integer','10–80 записей')},['task_id']),
 tool('tasks.dependency_graph','Проверить реальные технические зависимости, блокировки и этапы задач, прежде чем снимать или менять связи.',{}),
 tool('tasks.update_dependency','Самостоятельно исправить ошибочную техническую зависимость с аудитом. Меняй связь только при доказанном отсутствии реальной кодовой зависимости; не меняй зависимости для уже созданных веток.',{task_id:id,depends_on_task_id:{type:['string','null'],description:'UUID задачи-основания или null для удаления',format:'uuid'},reason:field('string','Обоснование изменения связи'),idempotency_key:idem},['task_id','depends_on_task_id','reason']),
 tool('tasks.read','Прочитать актуальное состояние задачи, GitHub-ветку и PR, открытые вопросы, сохранённые ответы и историю. Перед работой по задаче прочитай её; дополнительные знания запрашивай адресно. Не считай прежнюю сводку актуальной без проверки.',{task_id:id},['task_id']),
 tool('tasks.request_owner_question_cleanup','По явному запросу пользователя открыть предпросмотр удаления из колонки «Вопросы к ПО». Учти задачи типа question, созданные аналитиком. Удаление — только после явного подтверждения владельца.',{}),
 tool('tasks.create','Создать задачу с конкретными требованиями в бэклоге. Запуск анализа и разработки выполняется отдельно.',{title:str,description:str,idempotency_key:idem},['title','description']),
 tool('tasks.route_execution','ПМ: после уже подтверждённого анализа переназначить задачу без изменений кода на получение настоящих браузерных артефактов. Нужен SHA из исходных требований, активных исполнителей быть не должно. PR/CI/деплой не создаются.',{task_id:id,source_sha:str,reason:str,idempotency_key:idem},['task_id','source_sha','reason']),
 tool('tasks.retry_evidence','Повторить браузерное исполнение задачи только после завершённой попытки с блокировкой; сохранить прежние доказательства и историю.',{task_id:id,reason:str,idempotency_key:idem},['task_id','reason']),
 tool('tasks.delete','Удалить ошибочную ещё не выполнявшуюся задачу по прямому поручению владельца. Если сервер сообщает о начатой работе/PR, используй tasks.cancel, а не отказывайся от цели.',{task_id:id,source_message_id:id},['task_id','source_message_id']),
 tool('tasks.cancel','Безопасно отменить уже начатую ненужную задачу с PR/QA по явному поручению владельца (не считать её сделанной). Платформа проверяет текущий источник разрешения, зависимости, активные процессы и несоединённый PR, закрывает PR и очищает ветку с аудитом. При отказе ищи разрешимый блокер.',{task_id:id,source_message_id:id},['task_id','source_message_id']),
 tool('questions.list','Посмотреть вопросы по документации (задачи типа question), включая их статус и привязку к документу.',{}),
 tool('questions.create','Задать вопрос владельцу продукта, привязав к документу.',{document_id:id,question:str,idempotency_key:idem},['document_id','question']),
 tool('documentation.prepare_spec','Передать аналитику автономное поручение изучить проект и подготовить ТЗ. Агент сам выбирает источники и инструменты. Завершение допустимо только с проверяемыми документами; при нехватке сведений агент задаёт вопрос ПМ.',{instructions:str,document_id:id,idempotency_key:idem},['instructions']),
 tool('documentation.resume_spec','Продолжить ранее приостановленное поручение аналитика после получения недостающей информации. Сохраняет исходную цель и документы; не запускай новую работу с нуля.',{job_id:id,answer:str,idempotency_key:idem},['job_id','answer']),
 tool('documentation.complete','Завершить собственное поручение после проверки существующих или новых страниц. Передай ID документов и реальное описание результата; backend подтвердит их существование и содержимое.',{document_ids:{type:'array',items:id},summary:str},['document_ids','summary']),
 tool('documentation.request_input','Приостановить поручение и задать ПМ конкретный вопрос, когда необходимой информации нет в доступных источниках. Не заявлять о выполнении.',{question:str,context:str},['question']),
 tool('documentation.answer_question','Сохранить явный ответ владельца на вопрос по ТЗ и поручить аналитику обновить связанную страницу.',{question_id:id,answer:str,idempotency_key:idem},['question_id','answer']),
 tool('documentation.import','Запустить через Temporal импорт Markdown из GitHub. Источники будут закреплены на SHA.',{source_url:str,instructions:str,idempotency_key:idem},['source_url']),
 tool('documentation.request_reset','Предложить пользователю открыть подтверждение полной очистки документации проекта. Вызывай только по явной просьбе пользователя удалить всю документацию. Вызов показывает кнопку и не изменяет документы.',{}),
 tool('documentation.rebuild','Поручить автономному аналитику пересобрать ТЗ из существующей документации и доступного кода без обязательного предварительного импорта. Аналитик сам выбирает единый документ или тематические страницы, сохраняет данные и очищает пустые дубли.',{instructions:str,idempotency_key:idem}),
 tool('documentation.organize','Поручить автономному аналитику упорядочить любые страницы документации, включая системную страницу ТЗ и ручные страницы. Структуру выбирает аналитик; для удаления пустых страниц есть documents.delete.',{instructions:str,idempotency_key:idem}),
 tool('approvals.answer_question','Передать конкретный ответ владельца на открытый вопрос агента через стандартный API, возобновляющий анализ задачи.',{task_id:id,note_id:id,answer:str},['task_id','note_id','answer']),
 tool('approvals.deliver_task_answer','Передать сохранённое сообщение владельца в конкретную задачу для повторной проверки аналитиком. Работает и для старых карточек без ID открытых вопросов. Сначала определи task_id через tasks.list/read и source_message_id из текущего сообщения или history.search. Никогда не выдумывай ответ: сервер прочитает подлинный текст из истории. Только по явному ответу или просьбе владельца передать ранее данный ответ.',{task_id:id,source_message_id:id},['task_id','source_message_id']),
 tool('approvals.decide','Применить явное решение владельца по открытому запросу менеджера задачи через стандартные серверные проверки и текущие ограничения workflow.',{task_id:id,request_id:id,choice:field('string','answer, approve_requirements, reject_requirements, wait_for_tools; исключения QA только по явному согласию владельца'),answer:field('string','Текст ответа владельца')},['task_id','request_id','choice']),
 tool('workflow.approve_development','Запустить разработку по явно подтверждённому поручению владельца через стандартный API; проверяет требования и блокировки.',{task_id:id},['task_id']),
 tool('tasks.close','Отметить задачу завершённой только когда фактически завершены слияние, выкладка и документация. Отмена и удаление — отдельные действия. Для закрытия требуется явное поручение владельца и подтверждённые артефакты.',{task_id:id,source_message_id:id},['task_id','source_message_id']),
 tool('workflow.move_task','По прямому поручению владельца переместить или вернуть задачу на указанный этап; ранее выполненные работа, PR и отчёты остаются. Для QA/слияния/выкладки применяются настоящие проверки, статус done вручную не выставляется.',{task_id:id,target_stage:{type:'string',enum:['backlog','analysis','development','testing','merge_queue','deployment','documentation','done']},source_message_id:id,reason:field('string','Кратко зачем нужен переход или что именно доделать')},['task_id','target_stage','source_message_id','reason']),
 tool('workflow.release_task','По явному сообщению владельца в чате конкретной задачи довести готовый PR до слияния и следующего этапа. Стандартные проверки QA/CI и согласования сохраняются; если этап заблокирован, сообщи точную причину. При automatic можно отправить готовую слитую задачу на выкатку.',{task_id:id,source_message_id:field('string','UUID текущего сообщения владельца в чате задачи')},['task_id','source_message_id']),
 tool('qa.retry','Повторно запустить независимое тестирование уже существующего PR. Используй для конкретной задачи по прямому запросу владельца или после исправления инфраструктурного сбоя. API проверяет статус Temporal, текущий PR, блокировки и запрещает параллельный QA. Не считать перезапуск подтверждением качества.',{task_id:id,idempotency_key:idem},['task_id']),
 tool('approvals.list','Прочитать запросы к владельцу и все открытые вопросы с task_id и note_id независимо от того, открыта ли карточка задачи.',{}),
 tool('discussions.list','Список тем ПМ проекта с открытыми и закрытыми обсуждениями.',{}),
 tool('discussions.read','Прочитать несколько сообщений конкретной темы по необходимости.',{topic_id:id,limit:field('number','До 20 сообщений')},['topic_id']),
 tool('history.search','Найти старое обсуждение в чате проекта, не загружая всю историю.',{query:str,limit:field('number','До 12 найденных сообщений')},['query']),
 tool('discussions.open','Создать тему обсуждения с владельцем и сразу отправить первый вопрос или сообщение. Повторно используй открытую тему с тем же смыслом.',{title:str,opening_message:str,awaiting_reply:field('boolean','Нужен ответ владельца. По умолчанию да.')},['title','opening_message']),
 tool('discussions.close','Закрыть обсуждение после ответа владельца и передачи решения. Можно открыть повторно через discussions.reopen.',{topic_id:id},['topic_id']),
 tool('discussions.reopen','Открыть закрытую тему для дополнительных уточнений.',{topic_id:id},['topic_id']),
 tool('agents.consult','Попросить другого специалиста разрешить конкретный технический вопрос текущей задачи. Ответ отслеживается в очереди и требует фактического источника.',{task_id:id,target_role:{type:'string',enum:['analysis','development','testing','architect','devops','documentation','manager']},question:str,idempotency_key:idem},['task_id','target_role','question']),
 tool('blockers.list','Прочитать активные блокеры задачи и ранее принятые решения.',{task_id:id}),
 tool('blockers.report','Зафиксировать реальное препятствие, доказательства и возможное устранение.',{task_id:id,kind:{type:'string',enum:['requirements','tool','ci','qa','github','dependency','environment','code','other']},summary:str,evidence:str,resolution_hint:str,idempotency_key:idem},['task_id','kind','summary','evidence']),
 tool('blockers.resolve','Подтвердить устранение блокера после фактической проверки.',{blocker_id:id,resolution_evidence:str,idempotency_key:idem},['blocker_id','resolution_evidence']),
 tool('processes.list','Получить процессы. По конкретному process_id можно прочитать отчёт QA по запросу пользователя.',{task_id:id,process_id:id}),
 tool('processes.report','Зафиксировать прогресс автономного агента в журнале.',{stage:str,message:str},['stage','message']),
 tool('memory.list','Прочитать накопленный опыт и предлагаемые инструкции.',{}),
 tool('memory.record','Сохранить опыт либо предложить улучшение инструкции. Опыт не становится автоматически обязательным правилом.',{kind:field('string','observation или instruction_suggestion'),text:str,evidence:str,idempotency_key:idem},['kind','text'])
];
// Orders track successful mutations, not reads or routine agent telemetry.
// Catalog metadata keeps future tools classified without keyword heuristics.
const pmNonOrderTools=new Set(['pm.orders.update','processes.report','memory.record','instructions.propose']);
export function isProjectManagerOrderAction(name:string){
 const tool=agentToolCatalog.find(entry=>entry.name===name);
 return !!tool&&!tool.annotations.readOnlyHint&&!pmNonOrderTools.has(name);
}

export const readerRoles=['manager','analyst','business_analyst','analysis','development','testing','documentation','devops','architect'] as const;
export type AgentRole=typeof readerRoles[number];
export type AgentReaderScope={projectId:string;role:AgentRole;taskId?:string;processId?:string;actorId?:string};

const readerTools=new Set([
 'project.context','documents.search','documents.read','knowledge.search','knowledge.read','knowledge.sections','knowledge.section','knowledge.related','knowledge.context',
 'tasks.list','tasks.read','tasks.history','processes.list','blockers.list','project.source','work.list','work.artifacts','agents.capabilities','capabilities.list','capabilities.describe'
]);

const autonomousSpecialistRoles=new Set<AgentRole>(['analysis','development','testing','documentation','devops','architect']);
const specialistTools=new Set([...readerTools,'agents.consult','work.delegate','work.report','blockers.report','blockers.resolve','processes.report']);
const documentationTools=new Set([...readerTools,'work.delegate','work.report','documents.list','documents.create','documents.update','documents.delete','documents.changeset','documentation.complete','documentation.request_input']);
/** Business analysts own product knowledge, not the executable backlog. A handoff
 * requires an explicit authenticated user action outside the model tool catalog. */
const BA_DENIED=new Set(['documentation.complete','documentation.request_input','documentation.resume_spec','project.agents.start','tasks.delete','tasks.cancel','tasks.close','tasks.request_owner_question_cleanup','questions.create','iterations.recommend_launch','iterations.launch','tasks.update_dependency','workflow.move_task']);
const PM_DENIED=new Set(['documentation.complete','documentation.request_input','documents.create','documents.update','documents.delete','documents.changeset','questions.create']);
const BA_DENIED_GOVERNANCE=new Set(['instructions.propose','instructions.reconcile']);
/** The MCP catalog is the authoritative schema; capability views are derived, never maintained separately. */
export function capabilitiesForRole(role:AgentRole,readOnly=false,category?:string,grants:readonly string[]=[]){
 return toolsForSession(role,readOnly,grants).filter(t=>!category||t.name.startsWith(category+'.')).map(t=>({
  name:t.name,category:t.name.split('.')[0],description:t.description,
  inputSchema:t.inputSchema,readOnly:t.annotations.readOnlyHint,
  effects:t.annotations.readOnlyHint?'read':'write',
  requiresConfirmation:['tasks.delete','tasks.cancel','tasks.close','workflow.approve_development','workflow.release_task','iterations.approve','iterations.launch'].includes(t.name)
 }));
}
export function toolsForRole(role:AgentRole,readOnly=false){
 if(readOnly)return agentToolCatalog.filter(tool=>readerTools.has(tool.name));
 if(role==='documentation')return agentToolCatalog.filter(tool=>documentationTools.has(tool.name));
 if(autonomousSpecialistRoles.has(role))
  return agentToolCatalog.filter(tool=>specialistTools.has(tool.name));
 return agentToolCatalog.filter(t=>role==='manager'?!PM_DENIED.has(t.name)&&t.name!=='documentation.request_reset':!BA_DENIED.has(t.name)&&!BA_DENIED_GOVERNANCE.has(t.name)&&!t.name.startsWith('discussions.')&&!t.name.startsWith('approvals.')&&!t.name.startsWith('workflow.')&&!t.name.startsWith('pm.')&&!t.name.startsWith('qa.'));
}
/** Effective tools, evaluated on every request from an active, task-bound assignment. */
export function toolsForSession(role:AgentRole,readOnly=false,grants:readonly string[]=[]){
 const baseline=toolsForRole(role,readOnly);
 if(readOnly||!grants.length)return baseline;
 const additional=new Set(normalizeTaskToolGrants(grants));
 return agentToolCatalog.filter(tool=>additional.has(tool.name)||baseline.includes(tool));
}
export async function readSessionToolGrants(pool:Pick<Pool,'query'>,session:AgentSession,lock=false):Promise<string[]>{
 if(session.read_only||!session.task_id||!session.process_id||
    !autonomousSpecialistRoles.has(session.role))return [];
 // A session token alone is never sufficient: the assignment and its spec must
 // still be live in the same project and task, including after cancellation.
 let active;
 try{active=await pool.query(`SELECT a.granted_tools FROM agent_work_assignments a
  JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id AND t.spec_version=a.spec_version
  JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL AND p.agents_running=true
  WHERE a.id=$1 AND a.project_id=$2 AND a.task_id=$3 AND a.role=$4
   AND a.status='running' LIMIT 1${lock?' FOR SHARE OF a,t':''}`,
  [session.process_id,session.project_id,session.task_id,session.role]);}
 catch(error){
  // Legacy isolated reader fixtures may not have run the v15 schema yet.
  // No table/column means no extra privileges; never infer a grant.
  if(['42P01','42703'].includes(String((error as {code?:string}).code||'')))return [];
  throw error;
 }
 return active.rowCount?normalizeTaskToolGrants(active.rows[0].granted_tools||[]):[];
}

export function toolAllowedForRole(role:AgentRole,name:string){
 return toolsForRole(role).some(t=>t.name===name);
}
export type AgentSession={id:string;project_id:string;actor_id:string;role:AgentRole;status:string;expires_at:Date;read_only?:boolean;task_id?:string|null;process_id?:string|null};

export async function initAgentToolsSchema(pool:Pick<Pool,'query'>){
 await pool.query([
 'CREATE TABLE IF NOT EXISTS agent_sessions(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,actor_id uuid NOT NULL REFERENCES users(id),role text NOT NULL,token_hash text NOT NULL UNIQUE,status text NOT NULL DEFAULT \'running\',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz)',
 'ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false',
 'ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id) ON DELETE CASCADE',
 'ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS process_id uuid',
 'CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id,created_at DESC)',
 'CREATE TABLE IF NOT EXISTS agent_tool_events(id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,tool text NOT NULL,arguments jsonb NOT NULL DEFAULT \'{}\'::jsonb,result jsonb,success boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),idempotency_key text)',
 'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_idempotency ON agent_tool_events(project_id,tool,idempotency_key) WHERE idempotency_key IS NOT NULL AND success',
 'CREATE INDEX IF NOT EXISTS idx_agent_tool_events_session ON agent_tool_events(session_id,created_at)',
 'CREATE TABLE IF NOT EXISTS agent_memory(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,role text NOT NULL,kind text NOT NULL,body text NOT NULL,evidence text NOT NULL DEFAULT \'\',status text NOT NULL DEFAULT \'recorded\',created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz)',
 'CREATE INDEX IF NOT EXISTS idx_agent_memory_project ON agent_memory(project_id,created_at DESC)',
 'CREATE TABLE IF NOT EXISTS agent_blockers(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,process_id uuid,role text NOT NULL,kind text NOT NULL CHECK(kind IN (\'requirements\',\'tool\',\'ci\',\'qa\',\'github\',\'dependency\',\'environment\',\'code\',\'other\')),summary text NOT NULL,evidence text NOT NULL,resolution_hint text NOT NULL DEFAULT \'\',status text NOT NULL DEFAULT \'open\' CHECK(status IN (\'open\',\'resolved\')),resolution_evidence text NOT NULL DEFAULT \'\',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())',
 'CREATE INDEX IF NOT EXISTS idx_agent_blockers_task ON agent_blockers(project_id,task_id,status,created_at DESC)'
 ].join(';\n')+';');
}
export async function createAgentSession(pool:Pick<Pool,'query'>,projectId:string,actorId:string,role:AgentRole,sourceMessageId?:string){
 const secret=randomBytes(32).toString('hex'),id=randomUUID();
 await pool.query("INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,expires_at,process_id) VALUES($1,$2,$3,$4,$5,now()+interval '40 minutes',$6)",
  [id,projectId,actorId,role,hashSecret(secret),sourceMessageId||null]);
 return {id,secret};
}
export async function createAgentReaderSession(pool:Pick<Pool,'query'>,scope:AgentReaderScope){
 const {projectId,role,taskId,processId,actorId}=scope;
 // Only documentation-write sessions need the documentation job table.
 // Task-only/reader tests and migrations may run without that table.
 const docJob=role==='documentation'&&!!processId;
 const docGuard=docJob?(taskId
  ?` AND EXISTS (SELECT 1 FROM agent_work_assignments a WHERE a.id=$4 AND a.project_id=p.id AND a.task_id=$3 AND a.role='documentation' AND a.status='running')`
  :` AND EXISTS (SELECT 1 FROM document_import_jobs j WHERE j.id=$4 AND j.project_id=p.id AND j.actor_id=COALESCE($2::uuid,p.owner_id) AND j.status='running')`):'';
 const result=await pool.query(`SELECT COALESCE($2::uuid,p.owner_id) AS actor_id FROM projects p
  WHERE p.id=$1 AND p.deleted_at IS NULL
   AND ($2::uuid IS NULL OR p.owner_id=$2 OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=$2))
   AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.id=$3))`+docGuard,
 docJob?[projectId,actorId??null,taskId??null,processId]:[projectId,actorId??null,taskId??null]);
 if(!result.rowCount)return null;
 const secret=randomBytes(32).toString('hex'),id=randomUUID();
 await pool.query(`INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,expires_at,read_only,task_id,process_id)
  VALUES($1,$2,$3,$4,$5,now()+interval '130 minutes',$8,$6,$7)`,
 [id,projectId,result.rows[0].actor_id,role,hashSecret(secret),taskId??null,processId??null,role==='documentation'?!processId:!autonomousSpecialistRoles.has(role)||!taskId||!processId]);
 return {id,secret};
}
export async function finishAgentSession(pool:Pick<Pool,'query'>,id:string){
 await pool.query("UPDATE agent_sessions SET status='completed',finished_at=now() WHERE id=$1 AND status='running'",[id]);
}
export async function readAgentSession(pool:Pick<Pool,'query'>,secret:string):Promise<AgentSession|null>{
 if(!/^[0-9a-f]{64}$/.test(secret))return null;
 const r=await pool.query("SELECT id,project_id,actor_id,role,status,expires_at,read_only,task_id,process_id FROM agent_sessions WHERE token_hash=$1 AND status='running' AND expires_at>now()",[hashSecret(secret)]);
 return r.rows[0]||null;
}
export async function agentSessionEffects(pool:Pick<Pool,'query'>,id:string){
 const rows=(await pool.query('SELECT tool,result,success,created_at FROM agent_tool_events WHERE session_id=$1 ORDER BY created_at,id',[id])).rows;
 const value=(name:string,key:string)=>rows.filter(r=>r.success&&r.tool===name).map(r=>r.result?.[key]).filter(Boolean).at(-1)||null;
 return {events:rows,created_document_id:value('documents.create','id'),created_task_id:value('tasks.create','id'),
  owner_question_cleanup_requested:value('tasks.request_owner_question_cleanup','requires_user_confirmation')===true,
  documentation_reset_requested:value('documentation.request_reset','requires_user_confirmation')===true,
  import_job_id:value('documentation.import','import_job_id')||value('documentation.rebuild','import_job_id')||value('documentation.organize','import_job_id')};
}
export async function agentLearnedContext(pool:Pick<Pool,'query'>,projectId:string,role:AgentRole){
 return agentMemoryContext(pool,projectId,role);
}
