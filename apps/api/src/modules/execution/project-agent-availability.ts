import type {Pool} from 'pg';

/** SQL-only project pause-gate access; the Temporal-specific retry policy belongs to its caller. */
export type ProjectAgentScope={
 projectId?:string;
 runId?:string;
 kind?:'analysis'|'peer'|'planning'|'documentation';
};

export class ProjectAgentAvailabilityError extends Error {
 constructor(message:string) {
  super(message);
  this.name='ProjectAgentAvailabilityError';
 }
}

export async function readProjectAgentAvailability(db:Pick<Pool,'query'>,scope:ProjectAgentScope):Promise<boolean> {
 let sql:string;
 const id=scope.projectId||scope.runId;
 if(!id)throw new ProjectAgentAvailabilityError('Не задан проект или процесс для проверки активности');
 if(scope.projectId)sql='SELECT agents_running FROM projects WHERE id=$1 AND deleted_at IS NULL';
 else if(scope.kind==='analysis')sql='SELECT p.agents_running FROM agent_analysis_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1';
 else if(scope.kind==='peer')sql='SELECT p.agents_running FROM agent_peer_queue r JOIN projects p ON p.id=r.project_id WHERE r.note_id=$1';
 else if(scope.kind==='planning')sql='SELECT p.agents_running FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id JOIN projects p ON p.id=i.project_id WHERE r.id=$1';
 else if(scope.kind==='documentation')sql='SELECT p.agents_running FROM document_import_jobs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1';
 else throw new ProjectAgentAvailabilityError('Неизвестный тип рабочего процесса');
 const result=await db.query(sql,[id]);
 if(!result.rowCount)throw new ProjectAgentAvailabilityError('Проект или рабочий процесс удалён');
 return result.rows[0].agents_running===true;
}
