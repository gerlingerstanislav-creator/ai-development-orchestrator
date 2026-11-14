import test from 'node:test';
import assert from 'node:assert/strict';
import {agentMemorySections,agentMemoryContext} from '../dist/agent-memory.js';
import {composeAgentPrompt} from '../dist/agent-prompt.js';

const poolWith=(rows)=>{
 const calls=[];
 return {calls,query:async(sql,params)=>{calls.push({sql,params});return {rows};}};
};

test('PM receives approved directives as instructions and experiences only as data',async()=>{
 const db=poolWith([
  {kind:'instruction_suggestion',body:'Используй уже существующие возможности проекта',applicability:{}},
  {kind:'observation',body:'В прошлый раз перевод требовал проверки альтернатив',applicability:{}}
 ]);
 const sections=await agentMemorySections(db,'project-1','manager','Выполни задачу');
 assert.match(sections.instructions,/существующие возможности проекта/);
 assert.doesNotMatch(sections.instructions,/В прошлый раз/);
 assert.match(sections.observations,/Опыт, не обязательное правило/);
 assert.doesNotMatch(sections.observations,/Используй уже существующие/);
 assert.deepEqual(db.calls[0].params,['project-1','manager']);
 assert.match(db.calls[0].sql,/status='approved'/);
 const prompt=composeAgentPrompt({
  role:'PM',objective:'Реши задачу',instructions:sections.instructions,
  context:sections.observations
 });
 assert.match(prompt,/\[\[ADO:IDENTITY\]\][\s\S]*существующие возможности/);
 assert.match(prompt,/\[\[ADO:CONTEXT\]\][\s\S]*В прошлый раз/);
});

test('scoped Laravel guidance is excluded from unrelated or unknown projects',async()=>{
 const db=poolWith([
  {kind:'instruction_suggestion',body:'Сначала проверь Laravel-пакеты',applicability:{technology:'Laravel'}},
  {kind:'instruction_suggestion',body:'Согласуй существенные архитектурные изменения',applicability:{}},
  {kind:'observation',body:'Laravel package registry contains options',applicability:{technology:'Laravel'}}
 ]);
 const unrelated=await agentMemorySections(db,'p','manager','Node.js React app');
 assert.doesNotMatch(unrelated.instructions,/Laravel-пакеты/);
 assert.doesNotMatch(unrelated.observations,/Laravel package/);
 assert.match(unrelated.instructions,/архитектурные изменения/);
 const unknown=await agentMemoryContext(db,'p','manager');
 assert.doesNotMatch(unknown,/Laravel-пакеты/);
 const applicable=await agentMemorySections(db,'p','manager','Приложение на Laravel');
 assert.match(applicable.instructions,/Laravel-пакеты/);
 assert.match(applicable.observations,/Laravel package/);
});

test('all applicability dimensions must match and technology names must not match substrings',async()=>{
 const db=poolWith([
  {kind:'instruction_suggestion',body:'Рекомендация для Go API',applicability:{technology:'Go',task_type:'API'}},
  {kind:'instruction_suggestion',body:'Решение для репозитория A',applicability:{repository:'owner/repo-a'}}
 ]);
 const noMatch=await agentMemorySections(db,'p','manager','MongoDB integration for owner/repo-b');
 assert.equal(noMatch.instructions,'');
 const missingTask=await agentMemorySections(db,'p','manager','Go project');
 assert.equal(missingTask.instructions,'');
 const match=await agentMemorySections(db,'p','manager','Go API in owner/repo-a');
 assert.match(match.instructions,/Рекомендация для Go API/);
 assert.match(match.instructions,/Решение для репозитория A/);
});

test('bounded memory skips oversized entries and keeps useful shorter rules',async()=>{
 const db=poolWith([
  {kind:'instruction_suggestion',body:'Слишком длинная инструкция '+ 'x'.repeat(600),applicability:{}},
  {kind:'instruction_suggestion',body:'Читай ТЗ перед разработкой',applicability:{}},
  {kind:'instruction_suggestion',body:'Читай ТЗ перед разработкой',applicability:{}}
 ]);
 const memory=await agentMemorySections(db,'p','manager','',{instructions:90,observations:40});
 assert.equal(memory.instructions,'- Читай ТЗ перед разработкой');
 assert.equal(memory.observations,'');
});
