import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseAppRoute,projectUrl,uuidPattern} from '../src/features/navigation/routes.ts';
import {DocumentMarkdown,pmDisplayText} from '../src/features/documentation/Markdown.tsx';

const id='123e4567-e89b-42d3-a456-426614174000';
test('routes preserve project sections, task detail and documentation locations',()=>{
 assert.deepEqual(parseAppRoute('/'),{kind:'projects'});
 assert.deepEqual(parseAppRoute('/projects'),{kind:'projects'});
 assert.deepEqual(parseAppRoute('/account/settings'),{kind:'account'});
 assert.deepEqual(parseAppRoute('/projects/'+id),{kind:'project',projectId:id,section:'tasks'});
 assert.deepEqual(parseAppRoute('/projects/'+id+'/tasks/'+id),{kind:'project',projectId:id,section:'tasks',taskId:id});
 assert.deepEqual(parseAppRoute('/projects/'+id+'/docs/'+id),{kind:'project',projectId:id,section:'docs',docId:id});
 assert.deepEqual(parseAppRoute('/projects/'+id+'/docs/plan'),{kind:'project',projectId:id,section:'plan',planning:true,iterationId:undefined});
 assert.deepEqual(parseAppRoute('/unrecognized'),{kind:'not-found'});
 assert.equal(uuidPattern.test(id),true);
 assert.equal(projectUrl(id,'qa'),'/projects/'+id+'/qa');
});
test('documentation markdown preserves safe links and escapes unsupported HTML',()=>{
 const html=renderToStaticMarkup(React.createElement(DocumentMarkdown,{
  source:'# Heading\n\nHello **world** and [source](https://example.test)\n\n<script>alert(1)</script>'
 }));
 assert.match(html,/<h1/);
 assert.match(html,/<strong>world<\/strong>/);
 assert.match(html,/href="https:\/\/example.test"/);
 assert.doesNotMatch(html,/<script>/);
 assert.match(html,/&lt;script&gt;/);
});
test('PM pseudo-link cleanup retains readable label but not invalid route',()=>{
 assert.equal(pmDisplayText('See [topic](orchestrator://project/fake) now'),'See topic now');
});
