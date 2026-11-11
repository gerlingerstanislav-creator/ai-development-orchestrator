import assert from 'node:assert/strict';
import test from 'node:test';
import {runnerAssistantPrompt} from '../dist/runner-assistant-prompt.js';

test('long supporting context fits the Runner request while retaining task requirements and evidence',()=>{
 const task='Актуальное ТЗ и критерии приёмки\n'+'а'.repeat(17000);
 const evidence='SHA кода: '+ 'a'.repeat(40);
 const prompt=runnerAssistantPrompt(task,evidence,'д'.repeat(32000));
 assert.equal(prompt.length,24000);
 assert.ok(prompt.startsWith(task+'\n\n'+evidence));
});
