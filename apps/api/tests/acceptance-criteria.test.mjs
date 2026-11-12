import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceCriteria,preserveAcceptanceCriteria} from '../dist/acceptance-criteria.js';
test('preserves owner acceptance criteria when an analyst shortens the specification',()=>{
 const original='Страница кругов\n\n### Критерии приёмки\n- На странице должно быть 10 кругов\n- Каждый круг имеет уникальный диаметр\n\n### Риски\n- Слабая контрастность';
 const updated=preserveAcceptanceCriteria(original,'Реализовать страницу с десятью кругами');
 assert.deepEqual(acceptanceCriteria(updated),['На странице должно быть 10 кругов','Каждый круг имеет уникальный диаметр']);
 assert.doesNotMatch(updated,/Слабая контрастность/);
});
test('does not duplicate criteria already preserved by an analyst',()=>{
 const original='Критерии приемки:\n1. На странице должно быть 10 кругов';
 const refined='Проверить страницу.\n\n### Критерии приёмки\n- На странице должно быть 10 кругов';
 assert.equal(preserveAcceptanceCriteria(original,refined),refined);
});
test('does not add invented criteria when none were specified',()=>{
 const description='Сделай страницу с десятью кругами';
 assert.equal(preserveAcceptanceCriteria(description,description),description);
});

test('adds omitted acceptance criterion inside the existing section instead of duplicating the heading',()=>{
 const original='### Критерии приёмки\n- На странице должно быть 10 кругов\n- Все круги разного цвета';
 const refined='### Критерии приёмки\n- На странице должно быть 10 кругов\n\n### Реализация\nСоздать HTML';
 const restored=preserveAcceptanceCriteria(original,refined);
 assert.equal((restored.match(/### Критерии приёмки/g)||[]).length,1);
 assert.deepEqual(acceptanceCriteria(restored),['На странице должно быть 10 кругов','Все круги разного цвета']);
 assert.match(restored,/### Реализация/);
});
