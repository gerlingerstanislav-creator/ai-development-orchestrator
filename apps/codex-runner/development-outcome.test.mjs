import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExistingImplementation,parseNoChangesNeeded} from './development-outcome.mjs';

const sha='a'.repeat(40);
const summary='Реализация уже существует в основной ветке и соответствует поставленным требованиям.';
const note=files=>'RESULT: already_implemented\nIMPLEMENTATION_EVIDENCE: '+
 JSON.stringify({summary,files,criteria:['Критерий: кнопка отображается; проверяемое поведение обеспечено компонентом.']});

test('developer may finish without a change only with a verifiable pinned SHA and tracked source',()=>{
 const evidence=parseExistingImplementation(note(['apps/web/src/main.tsx']),{
  headSha:sha,baseSha:sha,trackedFiles:['apps/web/src/main.tsx']
 });
 assert.equal(evidence.commit,sha);
 assert.deepEqual(evidence.files,['apps/web/src/main.tsx']);
 assert.match(evidence.criteria[0],/Критерий/);
});

test('no marker or missing evidence cannot silently pass as implemented',()=>{
 assert.equal(parseExistingImplementation('Ничего не менял',{headSha:sha,baseSha:sha,trackedFiles:[]}),null);
 assert.throws(()=>parseExistingImplementation('RESULT: already_implemented',{headSha:sha,baseSha:sha,trackedFiles:[]}),/подтверждение/);
 assert.throws(()=>parseExistingImplementation(note(['not-in-git.js']),{
  headSha:sha,baseSha:sha,trackedFiles:['apps/web/src/main.tsx']
 }),/не подтверждена/);
});

test('an unmerged task branch is never accepted as already integrated',()=>{
 assert.throws(()=>parseExistingImplementation(note(['src/a.ts']),{
  headSha:'b'.repeat(40),baseSha:sha,trackedFiles:['src/a.ts']
 }),/базовой ветки/);
 assert.throws(()=>parseExistingImplementation(note(['../secret']),{
  headSha:sha,baseSha:sha,trackedFiles:['../secret']
 }),/не подтверждена/);
});

test('no-change rework returns the same PR for independent QA only with explicit checked evidence',()=>{
 const msg='RESULT: no_changes_needed\nREWORK_REVIEW: '+JSON.stringify({
  summary:'Замечание QA касалось браузерного инструмента: реализация восемь линий уже находится в рабочей ветке.',
  files:['src/lines.html'],
  reasons:['В src/lines.html содержатся восемь элементов с независимыми цветами; QA нужно исполнить Chromium assert --case qa-1.']
 });
 const result=parseNoChangesNeeded(msg,{headSha:sha,trackedFiles:['src/lines.html','README.md']});
 assert.equal(result.commit,sha);
 assert.deepEqual(result.files,['src/lines.html']);
 assert.match(result.reasons[0],/Chromium assert/);
 assert.equal(parseNoChangesNeeded('Ничего менять не нужно',{headSha:sha,trackedFiles:['src/lines.html']}),null);
 assert.throws(()=>parseNoChangesNeeded('RESULT: no_changes_needed',{headSha:sha,trackedFiles:['src/lines.html']}),/REWORK_REVIEW/);
 assert.throws(()=>parseNoChangesNeeded(msg,{headSha:sha,trackedFiles:['not-existing.html']}),/не подтверждён/);
 assert.throws(()=>parseNoChangesNeeded(msg,{headSha:'not-a-sha',trackedFiles:['src/lines.html']}),/Нужны подробный/);
});
