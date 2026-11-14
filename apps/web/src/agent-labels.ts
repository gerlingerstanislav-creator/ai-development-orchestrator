export function aiAgentName(name:string){
 return 'AI-'+name.replace(/^AI-/i,'');
}

export const serviceStages:Partial<Record<string,string>>={
 backlog:'Здесь хранятся новые задачи до начала анализа. Их создаёт пользователь или AI-менеджер проекта.',
 merge_queue:'Платформа проверяет состояние PR и результаты проверок, затем выполняет слияние через GitHub.',
 done:'Платформа фиксирует завершение задачи после прохождения необходимых этапов.'
};

/** Process events are not all specialist turns. Remain render-safe against
 * older APIs and future roles even if a new kind leaks into the chat feed. */
const taskAgentLabels:Record<string,{name:string;active:string}>={
 analysis:{name:'Аналитик',active:'Ведётся анализ'},
 development:{name:'Разработчик',active:'Ведётся разработка'},
 testing:{name:'Тестировщик',active:'Ведётся тестирование'},
 qa_design:{name:'Тестировщик',active:'Готовятся тестовые сценарии'},
 documentation:{name:'Документатор',active:'Обновляется документация'},
 devops:{name:'DevOps',active:'Ведётся инфраструктурная работа'},
 architect:{name:'Архитектор',active:'Ведётся проектирование'}
};
export function taskAgentLabel(kind:string):{name:string;active:string}{
 return Object.hasOwn(taskAgentLabels,kind)?taskAgentLabels[kind]:
  {name:'Исполнитель',active:'Выполняется поручение'};
}
