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
import {initAgentToolsSchema} from '../agent-tools.js';
import {initQaSchema} from '../qa.js';
import {initQaWaiverSchema} from '../qa-waiver.js';
import {initCloudDiagnosticsSchema} from '../cloud-diagnostics.js';
import {installProjectIterationsSchema} from '../project-iterations.js';
import {installAgentWorkQueueSchema} from '../agent-work-scheduler.js';
import {initRequirementsSchema} from '../requirements.js';
import {initAutomaticDeployment} from '../deployment-automation.js';
import {installProjectTeamSchema} from '../project-team.js';
import {installEpicStageSync,backfillLegacyEpicStages} from '../epic-stage-sync.js';
import {installAnalysisFirstGate,repairLegacyAnalysisStates} from '../analysis-first-gate.js';
import {installTaskEvidenceSchema} from '../task-evidence.js';

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
  },
  {
   version:7,name:'agent-sessions-qa-and-diagnostics-settings',
   checksum:'ado-agent-qa-diagnostics-settings-v7',
   up:async database=>{
    // All are idempotent schema initializers; preserve existing session, QA
    // evidence, owner waivers and persisted diagnostics opt-in/out settings.
    // The base tables users/projects/tasks/ai_test_runs exist since v1.
    await initAgentToolsSchema(database);
    await initQaSchema(database);
    await initQaWaiverSchema(database);
    await initCloudDiagnosticsSchema(database);
   }
  },
  {
   version:8,name:'iterations-development-queue-and-requirements',
   checksum:'ado-iterations-development-queue-requirements-v8',
   up:async database=>{
    // v7 installs QA plans; the baseline installs task and project foundations.
    await installProjectIterationsSchema(database);
    await installAgentWorkQueueSchema(database);
    // The one-time task specification backfill belongs with this migration.
    await initRequirementsSchema(database);
   }
  },
  {
   version:9,name:'deployment-automation-storage',
   checksum:'ado-deployment-automation-storage-v9',
   up:database=>initAutomaticDeployment(database)
  },
  {
   version:10,name:'project-team-profile-and-memory-schema',
   checksum:'ado-project-team-profile-memory-v10',
   up:database=>installProjectTeamSchema(database)
  },
  {
   version:11,name:'workflow-stage-guards-and-legacy-repair',
   checksum:'ado-workflow-epic-analysis-guards-v11',
   up:async database=>{
    await installEpicStageSync(database);
    await backfillLegacyEpicStages(database);
    await repairLegacyAnalysisStates(database);
    await installAnalysisFirstGate(database);
   }
  },
  {
   version:12,name:'non-code-task-evidence-execution',
   checksum:'ado-task-evidence-v12',
   up:database=>installTaskEvidenceSchema(database)
  }
 ];
}
