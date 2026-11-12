import test from 'node:test';
import assert from 'node:assert/strict';
import {requireQualityGates} from '../dist/quality-gates.js';

const projectId='p',taskId='t',headSha='a'.repeat(40),baseSha='b'.repeat(40);
const db=rows=>({query:async(_sql,params)=>{
 assert.deepEqual(params,[projectId,taskId,headSha,baseSha]);
 return {rows};
}});
test('merge requires both successful internal CI and architect verdict on exact head/base SHA',async()=>{
 await assert.rejects(requireQualityGates(db([]),projectId,taskId,headSha,baseSha),/Нет успешного собственного CI/);
 await assert.rejects(requireQualityGates(db([{kind:'ci',status:'completed',verdict:'passed'}]),projectId,taskId,headSha,baseSha),/ревью архитектора/);
 await assert.rejects(requireQualityGates(db([{kind:'ci',status:'completed',verdict:'passed'},{kind:'review',status:'completed',verdict:'rejected'}]),projectId,taskId,headSha,baseSha));
 await requireQualityGates(db([{kind:'ci',status:'completed',verdict:'passed'},{kind:'review',status:'completed',verdict:'passed'}]),projectId,taskId,headSha,baseSha);
});
