import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestedRootForTopic,sourceFingerprint} from '../dist/documentation-import-structure.js';

test('thematic documentation is classified by meaning, not by source filename',()=>{
 const cases=[
  ['preorder','Предзаказ и выдача','spec'],
  ['loyalty','Система лояльности','spec'],
  ['market-research','Исследование рынка и конкурентов','research'],
  ['integration','Интеграции с POS и iiko','architecture'],
  ['ux','Дизайн интерфейса покупателя','design'],
  ['runbook','Запуск и эксплуатация','operations']
 ];
 for(const [key,title,expected] of cases)assert.equal(suggestedRootForTopic(key,title),expected,title);
});

test('source change fingerprints detect manual edits without depending on parent folder',()=>{
 const title='Источник · README.md',body='# README\nОписание проекта';
 assert.equal(sourceFingerprint(title,body),sourceFingerprint(title,body));
 assert.notEqual(sourceFingerprint(title,body),sourceFingerprint(title,body+'\nРучное изменение'));
});
