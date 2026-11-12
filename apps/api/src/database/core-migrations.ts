import type {SchemaMigration} from './schema-migrations.js';
import {applyLegacySchema} from './legacy-bootstrap.js';
import {initAgentPromptAudit} from '../agent-prompt.js';
import {initTaskAgentNotesSchema} from '../task-agent-notes.js';
import {initAgentPeerQueue} from '../agent-peer-queue.js';
import {initTaskAnalysisQueue} from '../task-analysis-queue.js';

/**
 * Append-only, transactional schema history.
 *
 * Version 1 remains unchanged for existing installations with persisted ledgers.
 * Version 2 moves agent audit/queues into the same migration discipline.
 * Only pure DDL belongs here; per-restart operational policies stay in main().
 */
export function coreSchemaMigrations(stageDescriptions:Record<string,string>):readonly SchemaMigration[]{
 return [
  {
   version:1,name:'legacy-schema-baseline',checksum:'ado-legacy-schema-baseline-v1',
   up:database=>applyLegacySchema(database,stageDescriptions)
  },
  {
   version:2,name:'agent-audit-notes-and-queues',checksum:'ado-agent-audit-notes-queues-v2',
   up:async database=>{
    // Dependency order: projects/tasks/users -> notes -> peer queue.
    await initAgentPromptAudit(database);
    await initTaskAgentNotesSchema(database);
    await initAgentPeerQueue(database);
    await initTaskAnalysisQueue(database);
   }
  }
 ];
}
