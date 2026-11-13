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
import {initProjectManagerSchema} from '../project-manager.js';
import {initChatImages} from '../chat-images.js';
import {initTaskCancellationSchema} from '../task-cancellation.js';
import {installDiagnosticStorageSchema} from '../diagnostics.js';

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
    // Manager history and chat images are installed in dependency order by v5.
    await initQualityGateSchema(database);
    await initTaskOrchestrationSchema(database);
    await initProjectManagerInbox(database);
   }
  },
  {
   version:4,name:'merge-batch-schema',checksum:'ado-merge-batch-ddl-v4',
   up:database=>installMergeBatchSchema(database)
  },
  {
   version:5,name:'manager-chat-history-and-attachments',checksum:'ado-manager-chat-attachments-ddl-v5',
   up:async database=>{
    // Explicit dependency order: baseline projects/tasks/users/assistant_messages,
    // then manager_messages/manager_requests, then chat_images with both FKs.
    await initProjectManagerSchema(database);
    await initChatImages(database);
   }
  },
  {
   version:6,name:'task-cancellation-and-diagnostic-storage',checksum:'ado-task-cancellation-diagnostics-v6',
   up:async database=>{
    // Dependency order: baseline projects, users, tasks and documents already exist.
    // Retention timers and cleanup remain runtime policies, never migrations.
    await initTaskCancellationSchema(database);
    await installDiagnosticStorageSchema(database);
   }
  }
 ];
}
