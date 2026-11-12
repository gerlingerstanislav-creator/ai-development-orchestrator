type Responsibility={role:string|null;trigger:string;result:string;participants?:{role:string;assignment:string}[]};

const responsibilities:Record<string,Responsibility>={
 backlog:{role:'manager',trigger:'Пользователь или ПМ добавил задачу.',result:'Постановка и материалы готовы к анализу.'},
 analysis:{role:'analysis',trigger:'Новая задача в «Анализе» либо получены ответы на её вопросы.',result:'ТЗ и критерии приёмки готовы либо задан конкретный вопрос владельцу.',participants:[{role:'manager',assignment:'Запросить решение владельца и передать его единому BA/SA.'},{role:'architect',assignment:'Консультация по значимым архитектурным альтернативам при необходимости.'}]},
 development:{role:'development',trigger:'Задача готова, запуск разрешён для актуальной ревизии, зависимости и слот свободны.',result:'PR с реализацией и пояснением, что изменилось; затем независимое код-ревью архитектора.'},
 testing:{role:'testing',trigger:'Разработчик подготовил PR. QA проверяет актуальный commit SHA и изменения в комментариях; отдельная сверка аналитиком SHA не обязательна.',result:'Отчёт по подтверждённым и заблокированным кейсам. При дефектах задача возвращается разработчику для адресных исправлений.',participants:[{role:'analysis',assignment:'Уточнять новые требования при необходимости, не задерживая самостоятельную проверку QA.'},{role:'development',assignment:'Исправлять только подтверждённые дефекты в существующей ветке и PR.'}]},
 merge_queue:{role:null,trigger:'QA подтвердил результат для текущего коммита PR.',result:'PR слит после подтверждённого архитектурного ревью, QA и собственного CI.'},
 deployment:{role:'devops',trigger:'PR слит и включена выкладка для проекта.',result:'Выкладка подтверждена либо выполнен согласованный пропуск.'},
 documentation:{role:'documentation',trigger:'Работа над кодом завершена, выкладка завершена или пропущена.',result:'Документация актуализирована по фактическим изменениям.'},
 done:{role:null,trigger:'Обязательные этапы задачи завершены.',result:'Результат задачи зафиксирован.'}
};

export function workflowResponsibility(stage:string){
 return responsibilities[stage]??null;
}
