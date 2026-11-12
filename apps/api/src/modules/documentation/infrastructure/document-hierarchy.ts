import type {Pool} from 'pg';

/**
 * Validate document ownership and guard against direct and indirect cycles.
 * Caller controls transaction boundaries for document changes.
 */
export async function validDocParent(db:Pick<Pool,'query'>,projectId:string, docId:string|null, parentId:string|null) {
 if(!parentId)return true;
 const parent=await db.query('SELECT id FROM documents WHERE id=$1 AND project_id=$2',[parentId,projectId]);
 if(!parent.rowCount || parentId===docId)return false;
 if(docId) {
  const ancestors=await db.query(`WITH RECURSIVE chain AS (
   SELECT id,parent_id FROM documents WHERE id=$1 AND project_id=$2
   UNION ALL
   SELECT d.id,d.parent_id FROM documents d JOIN chain c ON c.parent_id=d.id WHERE d.project_id=$2
  ) SELECT 1 FROM chain WHERE id=$3 LIMIT 1`,[parentId,projectId,docId]);
  if(ancestors.rowCount)return false;
 }
 return true;
}
