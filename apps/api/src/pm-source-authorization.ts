import type {Pool} from 'pg';

/** Bind destructive PM actions to the authenticated, *current* owner message.
 * The current turn may be a Temporal continuation of the same PM order.
 * This uses provenance and existing API safety gates, never language regexes.
 */
export async function authorizePmDestructiveSource(
 db:Pick<Pool,'query'>,
 args:{projectId:string;actorId:string;currentMessageId?:string|null;sourceMessageId:string}
):Promise<void>{
 const {projectId,actorId,currentMessageId,sourceMessageId}=args;
 if(!currentMessageId)throw Object.assign(Error('Нет текущего сообщения для опасного действия'),{statusCode:403});
 const allowed=await db.query(`SELECT 1 FROM assistant_messages turn
  WHERE turn.id=$1 AND turn.project_id=$3 AND turn.actor_id=$4 AND turn.role='user'
   AND (turn.channel='project' AND turn.id=$2
    OR turn.channel='pm-internal' AND EXISTS(
      SELECT 1 FROM assistant_messages source JOIN project_pm_orders o ON o.id=turn.pm_order_id
       WHERE source.id=$2 AND source.project_id=$3 AND source.actor_id=$4
        AND source.role='user' AND source.channel='project'
        AND (source.pm_order_id=o.id OR source.id=o.source_message_id)))
  UNION ALL SELECT 1 FROM manager_messages turn
   WHERE turn.id=$1 AND turn.id=$2 AND turn.project_id=$3
    AND turn.actor_id=$4 AND turn.role='user'
  LIMIT 1`,[currentMessageId,sourceMessageId,projectId,actorId]);
 if(!allowed.rowCount)throw Object.assign(Error('Опасное действие требует исходного сообщения владельца из текущего поручения'),{statusCode:403});
}
