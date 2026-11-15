import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePmScreenshotReferences} from '../src/features/chat/pm-screenshot-references.ts';

const project='c74f1c09-b114-4be8-9237-b34de73c146d';
const task='63068e41-58e5-4bbb-91ff-f16ec2a413da';
const desktop='675d92e6-c433-4a22-9bf2-6385a9de0253';
const mobile='50ba481c-630c-46de-95b0-c7a8f9d9e792';
const screenshot=id=>'/api/projects/'+project+'/tasks/'+task+'/pm-browser-artifacts/'+id;

test('old PM image Markdown displays existing local desktop/mobile JPEGs without new browser.capture',()=>{
 const body='Снимки уже сохранены как настоящие JPEG артефакты. Прикрепляю их:\n\n'+
  '![Главная страница, desktop 1440×900]\\('+screenshot(desktop)+')\n\n'+
  '![Главная страница, mobile 390×844]\\('+screenshot(mobile)+')\n\n'+
  'Это локальные Chromium снимки с SHA 389c612e8cd6c131890154606c19410c4a76bdce.';
 const result=parsePmScreenshotReferences(body,project);
 assert.deepEqual(result.images.map(x=>x.artifactId),[desktop,mobile]);
 assert.equal(result.images[0].label,'Главная страница, desktop 1440×900');
 assert.ok(result.images.every(x=>x.url.startsWith('/api/projects/'+project+'/tasks/'+task)));
 assert.doesNotMatch(result.markdown,/pm-browser-artifacts/);
 assert.match(result.markdown,/389c612e8cd6c131890154606c19410c4a76bdce/);
});

test('old PM link Markdown with spaces and escaped parenthesis resolves protected JPEG paths',()=>{
 const input='Ссылки на существующие скриншоты:\n\n'+
  '- [Desktop, 1440×900]\\( '+screenshot(desktop)+' )\n'+
  '- [Mobile, 390×844]\\( '+screenshot(mobile)+' )';
 const result=parsePmScreenshotReferences(input,project);
 assert.equal(result.images.length,2);
 assert.deepEqual(result.images.map(x=>x.label),['Desktop, 1440×900','Mobile, 390×844']);
 assert.ok(!result.markdown.includes('/api/projects/'));
});

test('nonmatching project, external URLs, generic docs and duplicate references remain safe',()=>{
 const other='11111111-1111-1111-1111-111111111111';
 const input='![Not this project]('+screenshot(desktop)+')\n'+
  '![external](https://example.org/image.png)\n'+
  '[ordinary guide](https://example.org/docs)';
 const blocked=parsePmScreenshotReferences(input,other);
 assert.deepEqual(blocked.images,[]);
 assert.equal(blocked.markdown,input);
 const duplicate=parsePmScreenshotReferences(
  '[Desktop]('+screenshot(desktop)+')\n![Again]('+screenshot(desktop)+')',project);
 assert.deepEqual(duplicate.images.map(x=>x.artifactId),[desktop]);
 assert.doesNotMatch(duplicate.markdown,/pm-browser-artifacts/);
});
