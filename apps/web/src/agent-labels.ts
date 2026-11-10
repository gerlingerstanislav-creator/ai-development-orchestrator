export function aiAgentName(name:string){
 return 'AI-'+name.replace(/^AI-/i,'');
}

export const serviceStages:Partial<Record<string,string>>={
 backlog:'Здесь хранятся новые задачи до начала анализа. Их создаёт пользователь или AI-менеджер проекта.',
 merge_queue:'Платформа проверяет состояние PR и результаты проверок, затем выполняет слияние через GitHub.',
 done:'Платформа фиксирует завершение задачи после прохождения необходимых этапов.'
};
