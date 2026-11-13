import type {SchemaMigration} from './schema-migrations.js';
import {applyLegacySchema} from './legacy-bootstrap.js';
import {initAgentPromptAudit} from '../agent-prompt.js';
import {initTaskAgentNotesSchema} from '../task-agent-notes.js';
import {initAgentPeerQueue} from '../agent-peer-queue.js';
import {initTaskAnalysisQueue} from '../task-analysis-queue.js';
import {initQualityGateSchema} from '../quality-gates.js';
import {initTaskOrchestrationSchema} from '../task-orchestration.js';
import {initProjectManagerInbox} from '../project-manager-inbox.js';
import {installMergeBatchSchema} from '../merge-batch.js';

/**
 * Append-only, transactional schema history.
 *
 * Version 1 remains unchanged for existing installations with persisted ledgers.
 * Version 2 moves agent audit/queues into the same migration discipline.
 * Versions 3+ add isolated infrastructure schemas with no runtime data policy.
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
  },
  {
   version:3,name:'quality-orchestration-and-pm-inbox',checksum:'ado-quality-orchestration-pm-inbox-v3',
   up:async database=>{
    // These initializers perform only CREATE/ALTER/INDEX DDL. Their referenced
    // users/projects/tasks/messages exist after the legacy schema baseline.
    // Chat images and merge/deployment schemas remain startup-managed because
    // their dependencies must be migrated separately.
    await initQualityGateSchema(database);
    await initTaskOrchestrationSchema(database);
    await initProjectManagerInbox(database);
   }
  },
  {
   version:4,name:'merge-batch-schema',checksum:'ado-merge-batch-ddl-v4',
   up:database=>installMergeBatchSchema(database)
  }
 ];
}
