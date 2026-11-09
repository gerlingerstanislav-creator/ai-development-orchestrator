import test from 'node:test';
import assert from 'node:assert/strict';
import {extractGitHubDocumentLocation,resolveGitHubDocumentCommit,readGitHubMarkdownFiles} from '../dist/github-document-import.js';

test('a GitHub folder URL is pinned to one immutable commit for every source read',async()=>{
 const source=extractGitHubDocumentLocation('https://github.com/gerlingerstanislav-creator/ideas/tree/main/coffee-preorder-43-0.3');
 assert.ok(source);
 const pinned='9fc9329d2606d65b5da54dcfd59abb83b35530b5';
 const markdown='# Кофейня\n\nОбработка предварительных заказов.';
 const original=globalThis.fetch,calls=[];
 try{
  globalThis.fetch=async url=>{
   const link=String(url);calls.push(link);
   if(link.endsWith('/commits/main'))return Response.json({sha:pinned});
   assert.ok(link.endsWith('?ref='+pinned),'All content queries must use the resolved commit: '+link);
   if(link.includes('/contents/coffee-preorder-43-0.3?'))
    return Response.json([{type:'file',name:'REQUIREMENTS.md',path:'coffee-preorder-43-0.3/REQUIREMENTS.md',size:Buffer.byteLength(markdown)}]);
   if(link.includes('/contents/coffee-preorder-43-0.3/REQUIREMENTS.md?'))
    return Response.json({type:'file',encoding:'base64',content:Buffer.from(markdown).toString('base64')});
   throw Error('Unexpected GitHub API request '+link);
  };
  const commit=await resolveGitHubDocumentCommit(source,[]);
  assert.equal(commit,pinned);
  const documents=await readGitHubMarkdownFiles({...source,branch:commit},[]);
  assert.deepEqual(documents.map(doc=>({path:doc.path,body:doc.body})),[
   {path:'coffee-preorder-43-0.3/REQUIREMENTS.md',body:markdown}
  ]);
  assert.equal(calls.length,3);
  assert.equal(calls.filter(link=>link.includes('?ref='+pinned)).length,2);
 }finally{globalThis.fetch=original;}
});
