import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkArchitecture} from './check-architecture.mjs';

test('detect cycles and forbidden application-to-database imports',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ado-boundary-'));
 try{
  const dir=path.join(root,'apps/api/src/modules/test/application');
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'a.ts'),"import {b} from './b.js'; import type {Pool} from 'pg'; export const a=b;");
  await writeFile(path.join(dir,'b.ts'),"import {a} from './a.js'; export const b=a;");
  const errors=await checkArchitecture(root);
  assert.ok(errors.some(e=>e.includes('Circular import:')));
  assert.ok(errors.some(e=>e.includes('cannot import pg')));
 }finally{await rm(root,{recursive:true,force:true})}
});

test('accept a feature dependency graph without cycles',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ado-boundary-'));
 try{
  const dir=path.join(root,'apps/web/src/features/docs');
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'index.ts'),"export {render} from './render.js';");
  await writeFile(path.join(dir,'render.ts'),"export const render=(text:string)=>text;");
  assert.deepEqual(await checkArchitecture(root),[]);
 }finally{await rm(root,{recursive:true,force:true})}
});
