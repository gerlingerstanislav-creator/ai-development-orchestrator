/**
 * A question addressed to a specialist is a task-linked technical
 * consultation, not a request for a product decision from the owner.
 * It may be retried / reported in the Process Center but must not block
 * requirements analysis, developer dispatch or independent QA.
 *
 * Explicit owner requests (requires_customer) and legacy task-wide owner
 * questions (target_stage='all') retain their existing mandatory gate.
 *
 * SQL callers MUST alias task_agent_notes as "n" and use this expression
 * in both the candidate SELECT and the corresponding UPDATE predicate.
 */
export const PENDING_OWNER_QUESTION_SQL=
 "(n.kind='question' AND n.status IN ('open','processing') AND (n.requires_customer OR n.target_stage='all'))";
