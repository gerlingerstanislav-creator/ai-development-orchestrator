import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentDecision} from '../dist/deployment-stage.js';

test('deployment is skipped by default and never described as success',()=>{
 assert.deepEqual(deploymentDecision('skip'),{
  stage:'documentation',status:'skipped',
  reason:'Нет настроенного окружения: этап выкладки пропущен согласно настройкам проекта'
 });
});
test('manual deployment waits for an explicit confirmation',()=>{
 const decision=deploymentDecision('manual');
 assert.equal(decision.stage,'deployment');
 assert.equal(decision.status,'pending');
});
test('unknown deployment mode fails closed',()=>{
 assert.throws(()=>deploymentDecision('github_actions'),/Неизвестный режим/);
 assert.throws(()=>deploymentDecision(null),/Неизвестный режим/);
});
