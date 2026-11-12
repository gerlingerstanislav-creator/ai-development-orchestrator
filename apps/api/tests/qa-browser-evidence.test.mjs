import test from 'node:test';
import assert from 'node:assert/strict';
import {browserPresent,checkedWithActualCapabilities,isVisualAcceptanceCase} from '../dist/qa-evidence.js';
const visual={id:'test-circle-colors',title:'Цвета кругов',steps:[{action:'Открыть страницу',expected:'10 разных цветов'}]};
test('isolated Playwright Chromium counts as a real browser capability',()=>{
 assert.equal(browserPresent('node: available\nqa_browser: playwright chromium available'),true);
 assert.equal(browserPresent('node: available\nqa_browser: unavailable'),false);
 assert.equal(isVisualAcceptanceCase(visual),true);
});
test('visual QA cannot pass without a verified browser assert command',()=>{
 const capabilities='qa_browser: playwright chromium available';
 const source={case_id:visual.id,result:'passed',reason:'executed',evidence:'grep .circle index.html → код 0. Был найден CSS'};
 const result=checkedWithActualCapabilities([visual],[source],capabilities);
 assert.equal(result.cases[0].result,'blocked');
 assert.equal(result.visualToolGap,true);
 assert.equal(result.cases[0].reason,'unverified');
});
test('real executed browser assertion unlocks visual test only with running Chromium',()=>{
 const source={case_id:visual.id,result:'passed',reason:'executed',
  evidence:'node /opt/codex-runner/browser-client.mjs assert "document.querySelectorAll(\'.circle\').length===10" → код 0. Все фигуры найдены'};
 assert.equal(checkedWithActualCapabilities([visual],[source],'qa_browser: playwright chromium available').cases[0].result,'passed');
 assert.equal(checkedWithActualCapabilities([visual],[source],'qa_browser: unavailable').cases[0].result,'blocked');
});
