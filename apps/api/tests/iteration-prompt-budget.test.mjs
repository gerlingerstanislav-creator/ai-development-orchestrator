import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedIterationPrompt,ITERATION_PROMPT_LIMIT} from '../dist/iteration-prompt-budget.js';

test('iteration prompts fit Codex Runner even when documents and history are oversized',()=>{
 const prompt=boundedIterationPrompt([
  'Ты системный аналитик. '+('инструкции '.repeat(200)),
  'Подтверждённое решение: интервал пять минут. '+('ответ '.repeat(10000)),
  'Исходные документы: '+('спецификация '.repeat(20000)),
 ],[1000,6000,15000]);
 assert.ok(prompt.length<=ITERATION_PROMPT_LIMIT);
 assert.match(prompt,/Ты системный аналитик/);
 assert.match(prompt,/Подтверждённое решение: интервал пять минут/);
 assert.match(prompt,/Исходные документы/);
 assert.match(prompt,/Фрагмент контекста сокращён/);
});

test('iteration prompt budgets preserve short sections without modification',()=>{
 assert.equal(boundedIterationPrompt(['Требования','Ответ владельца'],[500,500]),'Требования\n\nОтвет владельца');
});

test('iteration prompt budgets fail early when aggregate size is not safe',()=>{
 assert.throws(()=>boundedIterationPrompt(['a'.repeat(12000),'b'.repeat(12000)],[12000,12000]),/превышает безопасный лимит/);
 assert.throws(()=>boundedIterationPrompt(['ТЗ'],[]),/отсутствуют ограничения/);
});
