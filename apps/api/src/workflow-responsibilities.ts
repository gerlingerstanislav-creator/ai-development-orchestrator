/** Stable stage contract used by API, agent handoffs and workflow UI. */
type Responsibility={role:string|null;trigger:string;result:string;participants?:{role:string;assignment:string}[]};
const responsibilities:Record<string,Responsibility>={
 backlog:{
  role:'manager',trigger:'Пользователь или PM зарегистрировал запрос.',
  result:'Определены цель, тип, контекст и приоритет; задача передана на анализ.',
  participants:[{role:'analysis',assignment:'Помогает классифицировать и декомпозировать запрос при необходимости.'}]
 },
 analysis:{
  role:'analysis',trigger:'Новая задача или обновлённые вводные; исходные материалы доступны.',
  result:'Проверяемое ТЗ, критерии приёмки, зависимости и явно разрешённые продуктовые вопросы.',
  participants:[
   {role:'manager',assignment:'Собирает решения владельца и согласует значимые изменения.'},
   {role:'architect',assignment:'Оценивает важные технические альтернативы, ограничения и риски.'},
   {role:'testing',assignment:'Уточняет тестируемость и будущие проверки при необходимости.'}
  ]
 },
 development:{
  role:'development',trigger:'Анализ утверждён, необходимые решения получены, запуск разрешён и исполнитель доступен.',
  result:'Код и тесты в рабочей ветке, PR и независимое архитектурное ревью.',
  participants:[
   {role:'architect',assignment:'Проводит код-ревью конкретного SHA и проверяет архитектурную совместимость.'},
   {role:'testing',assignment:'Может готовить тестовые сценарии заранее, не подменяя итоговую QA.'},
   {role:'manager',assignment:'Разрешает продуктовые блокировки, но не переводит каждый шаг вручную.'}
  ]
 },
 testing:{
  role:'testing',trigger:'PR создан, изменения и SHA доступны для независимой проверки.',
  result:'Протокол проверок с доказательствами; дефекты возвращаются разработчику для исправления того же PR.',
  participants:[
   {role:'development',assignment:'Исправляет подтверждённые дефекты с повторным прохождением проверок.'},
   {role:'analysis',assignment:'Уточняет требования при реальных противоречиях, не подменяя QA.'},
   {role:'manager',assignment:'Эскалирует владельцу только решения и исключения.'}
  ]
 },
 merge_queue:{
  role:'platform',trigger:'Независимое QA и ревью подтверждены для текущего SHA.',
  result:'PR слит только после успешного собственного CI и проверок качества; результат записан.',
  participants:[
   {role:'architect',assignment:'Подтверждает отсутствие блокирующих замечаний к актуальному SHA.'},
   {role:'manager',assignment:'Контролирует блокировки; не подменяет проверяемое слияние.'}
  ]
 },
 deployment:{
  role:'devops',trigger:'PR слит и выбран допустимый режим выкладки проекта.',
  result:'Подтверждённый релиз и health-check или явно записанный пропуск по политике окружения.',
  participants:[
   {role:'development',assignment:'Помогает диагностировать ошибки выкладки и совместимости.'},
   {role:'testing',assignment:'При необходимости проводит smoke-проверку после релиза.'}
  ]
 },
 documentation:{
  role:'documentation',trigger:'Реализация слита, выкладка завершена либо корректно пропущена.',
  result:'Документация актуализирована по фактически слитым изменениям, с привязкой к источникам.',
  participants:[
   {role:'analysis',assignment:'Проверяет соответствие требованиям и корректность терминологии.'},
   {role:'development',assignment:'Уточняет API, данные и технические последствия изменений.'}
  ]
 },
 done:{
  role:'manager',trigger:'Обязательные результаты анализа, реализации, QA, слияния и документации подтверждены.',
  result:'Итог зафиксирован; история, артефакты и ссылки сохранены.',
  participants:[{role:'platform',assignment:'Не закрывает задачу, если обязательные gates остаются незавершёнными.'}]
 }
};
export function workflowResponsibility(stage:string){return responsibilities[stage]??null;}
