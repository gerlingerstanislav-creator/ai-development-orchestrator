import test from 'node:test';
import assert from 'node:assert/strict';
import {PM_GOAL_POLICY} from '../dist/pm-goal-policy.js';
import {responsibilityFor} from '../dist/role-responsibilities.js';

test('PM diagnoses missing system capabilities before declaring a goal impossible',()=>{
 assert.match(PM_GOAL_POLICY,/capabilities\.list\/describe/);
 assert.match(PM_GOAL_POLICY,/agents\.capabilities/);
 assert.match(PM_GOAL_POLICY,/не выдумывай работоспособные инструменты/);
 assert.match(PM_GOAL_POLICY,/доступные обходные пути/);
});

test('PM proposes actionable workaround or platform extension rather than quietly failing',()=>{
 assert.match(PM_GOAL_POLICY,/доработку AI Development Orchestrator/);
 assert.match(PM_GOAL_POLICY,/кто это может реализовать/);
 assert.match(PM_GOAL_POLICY,/ограничения безопасности/);
 assert.match(PM_GOAL_POLICY,/рекомендуй лучший/);
 assert.match(PM_GOAL_POLICY,/goals\.update\(status=needs_action/);
 assert.match(PM_GOAL_POLICY,/Не вызывай goals\.complete/);
 assert.match(PM_GOAL_POLICY,/не создавай задачу на изменение самой платформы без соответствующего поручения/);
});

test('existing available workaround remains autonomous and ordinary discussion remains non-mutating',()=>{
 assert.match(PM_GOAL_POLICY,/используй его самостоятельно/);
 assert.match(PM_GOAL_POLICY,/не превращай каждый разговор в задачу/);
 assert.match(PM_GOAL_POLICY,/не перекладывай исполнение на пользователя/);
 assert.ok(responsibilityFor('manager').outcomes.some(outcome=>outcome.includes('доработки системы')));
});
