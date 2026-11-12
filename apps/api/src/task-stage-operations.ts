/**
 * PM may coordinate workflow, but cannot mark testing, merge, deployment or
 * documentation successful by moving a Kanban card. Those transitions are
 * owned by their actual verifiable workers.
 */
export type WorkStage='backlog'|'analysis'|'development'|'testing'|'merge_queue'|'deployment'|'documentation'|'done';
export type StageOperation='same'|'patch'|'reanalyze'|'developer_rework'|'resume_development'|'retry_qa'|'apply_qa'|'blocked';
export function planManagerStageMove(current:WorkStage,target:WorkStage,hasPr:boolean):{operation:StageOperation;reason:string}{
 if(current===target){
  if(current==='analysis')return {operation:'reanalyze',reason:'Переанализировать задачу с текущими комментариями'};
  if(current==='development')return {operation:'resume_development',reason:'Продолжить ранее начатую разработку'};
  if(current==='testing'||current==='merge_queue')return {operation:'retry_qa',reason:'Повторно проверить существующий PR'};
  return {operation:'same',reason:'Задача уже на этом этапе'};
 }
 if(['done','documentation','deployment'].includes(current))
  return {operation:'blocked',reason:'PR уже слит или выкладка началась; изменения оформляются новой связанной задачей'};
 if(['backlog','analysis'].includes(current)&&['backlog','analysis'].includes(target))
  return {operation:'patch',reason:'Перемещение между подготовительными этапами'};
 if(target==='analysis'&&['development','testing','merge_queue'].includes(current))
  return {operation:'reanalyze',reason:'Уточнить новые требования с сохранением ветки и PR'};
 if(target==='development'&&['testing','merge_queue'].includes(current))
  return {operation:hasPr?'developer_rework':'blocked',reason:hasPr?'Исправить текущий PR по замечаниям':'Для возврата после QA нужен существующий PR'};
 if(target==='development'&&current==='analysis')
  return {operation:'blocked',reason:'Аналитик должен завершить уточнение задачи; переход автоматический'};
 if(target==='testing'&&current==='development')
  return {operation:hasPr?'resume_development':'blocked',reason:hasPr?'Завершить передачу существующего PR в QA':'Для тестирования требуется PR'};
 if(target==='testing'&&current==='merge_queue')
  return {operation:'retry_qa',reason:'Повторный QA существующего PR'};
 if(target==='merge_queue'&&current==='testing')
  return {operation:'apply_qa',reason:'Применить ранее подтверждённый QA-результат'};
 return {operation:'blocked',reason:'Нельзя вручную обойти проверку требований, QA, GitHub CI, выкладку или документацию'};
}

/** Finishing is not cancellation. A PM may close a task only after a
 * successfully merged PR and updated documentation, with no pending reviews.
 */
export function canManagerCloseTask(stage:WorkStage,documented:boolean,hasMergedArtifact:boolean,pendingDocumentation:boolean):boolean{
 return stage==='documentation'&&documented&&hasMergedArtifact&&!pendingDocumentation;
}
