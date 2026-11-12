import {agentInstructions} from '../../../agent-instructions.js';

/** Shared initial lifecycle and stage definitions for project creation and SQL bootstrap. */
export const workflowDefaults = [
  ['backlog','Бэклог','manual'],
  ['analysis','Анализ','approval'],
  ['development','Разработка','approval'],
  ['testing','Тестирование','automatic'],
  ['merge_queue','Ожидает слияния','manual'],
  ['deployment','Выкладка','manual'],
  ['documentation','Документация','manual'],
  ['done','Готово','manual']
] as const;
export const workflowStageDescriptions:Record<string,string>={
 "backlog": "Новые задачи и идеи ожидают утверждённого объёма.",
 "analysis": "Аналитики прорабатывают требования, техническую реализацию и зависимости.",
 "development": "Разработчики реализуют готовые задачи и прикрепляют PR.",
 "testing": "QA проверяет изменения и при необходимости возвращает дефекты.",
 "merge_queue": "Проверенные PR последовательно сливаются в целевую ветку.",
 "deployment": "DevOps выполняет либо согласованно пропускает выкладку.",
 "documentation": "Документация актуализируется по фактической реализации.",
 "done": "Работа завершена, результат и история сохранены."
};
export const workflowAgentDefaults:Record<string,{name:string;instructions:string}>={
 backlog:{name:'',instructions:agentInstructions.backlog},
 analysis:{name:'Системный аналитик',instructions:agentInstructions.analysis},
 development:{name:'AI-разработчик',instructions:agentInstructions.development},
 testing:{name:'AI-тестировщик',instructions:agentInstructions.testing},
 deployment:{name:'AI-DevOps',instructions:agentInstructions.devops},
 documentation:{name:'AI-технический писатель',instructions:agentInstructions.documentation}
};
