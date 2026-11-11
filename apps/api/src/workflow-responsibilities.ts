type Responsibility={role:string|null;trigger:string;result:string;participants?:{role:string;assignment:string}[]};

const responsibilities:Record<string,Responsibility>={
 backlog:{role:'manager',trigger:'Пользователь или ПМ добавил задачу.',result:'Постановка и материалы готовы к анализу.'},
 analysis:{role:'analysis',trigger:'Новая задача в «Анализе» либо получены ответы на её вопросы.',result:'ТЗ и критерии приёмки готовы либо задан конкретный вопрос владельцу.',participants:[{role:'manager',assignment:'Запросить решение владельца и передать его аналитику.'}]},
 development:{role:'development',trigger:'Задача готова, запуск разрешён для актуальной ревизии, зависимости и слот свободны.',result:'PR с реализацией и пояснением, что изменилось.'},
 testing:{role:'testing',trigger:'Разработка завершена, системный аналитик сверил PR с ТЗ, подготовлен план QA.',result:'Отчёт для актуального коммита. При дефектах задача возвращается разработчику.',participants:[{role:'analysis',assignment:'Сверить фактические изменения PR с актуальным ТЗ.'},{role:'development',assignment:'Устранить подтверждённые дефекты после возврата задачи.'}]},
 merge_queue:{role:null,trigger:'QA подтвердил результат для текущего коммита PR.',result:'PR слит после подтверждения и обязательных проверок GitHub.'},
 deployment:{role:'devops',trigger:'PR слит и включена выкладка для проекта.',result:'Выкладка подтверждена либо выполнен согласованный пропуск.'},
 documentation:{role:'documentation',trigger:'Работа над кодом завершена, выкладка завершена или пропущена.',result:'Документация актуализирована по фактическим изменениям.'},
 done:{role:null,trigger:'Обязательные этапы задачи завершены.',result:'Результат задачи зафиксирован.'}
};

export function workflowResponsibility(stage:string){
 return responsibilities[stage]??null;
}
