import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExistingImplementation} from './development-outcome.mjs';

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
