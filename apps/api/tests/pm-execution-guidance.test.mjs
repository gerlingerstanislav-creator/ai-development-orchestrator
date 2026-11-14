import test from 'node:test';
import assert from 'node:assert/strict';
import {PM_EXECUTION_GUIDANCE} from '../dist/pm-execution-guidance.js';
import {PM_GOAL_POLICY} from '../dist/pm-goal-policy.js';

test('PM selects direct or delegated work without mandatory role pipeline',()=>{
 assert.match(PM_EXECUTION_GUIDANCE,/самый простой достаточный путь/);
 assert.match(PM_EXECUTION_GUIDANCE,/work\.plan|goals\.plan/);
 assert.match(PM_EXECUTION_GUIDANCE,/work\.artifacts/);
 assert.match(PM_EXECUTION_GUIDANCE,/не запускай ненужный цикл изменения кода/);
 assert.doesNotMatch(PM_EXECUTION_GUIDANCE,/сначала аналитик.*затем разработчик.*затем QA/i);
});
test('direct single actions do not require creation of a goal, while tracked work stays durable',()=>{
 assert.match(PM_GOAL_POLICY,/прямое разрешённое действие/);
 assert.match(PM_GOAL_POLICY,/Для долгой цели используй goals\.open/);
 assert.match(PM_GOAL_POLICY,/goals\.complete/);
 assert.match(PM_GOAL_POLICY,/не превращай каждый разговор в задачу/);
});
