import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {validateChatImages,chatImagesSchema,saveChatImages} from '../dist/chat-images.js';
import {validateRunnerImages,withRunnerImages} from '../../codex-runner/chat-images.mjs';

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const valid={name:'screenshot.png',mimeType:'image/png',data:png.toString('base64')};

test('accepts a PNG and retains its bytes without embedding them in the prompt',()=>{
 const images=validateChatImages([valid]);
 assert.equal(images.length,1);
 assert.deepEqual(images[0].data,png);
 assert.equal(images[0].name,'screenshot.png');
 assert.equal(validateRunnerImages([valid]).length,1);
});
test('rejects corrupted image, incorrect signature and excessive attachments',()=>{
 assert.throws(()=>validateChatImages([{...valid,data:'a'.repeat(64)}]),/содержимым|повреждено/i);
 assert.throws(()=>validateChatImages([{...valid,mimeType:'image/jpeg'}]),/PNG|JPEG|WebP/i);
 assert.equal(chatImagesSchema.safeParse([valid,valid,valid,valid,valid]).success,false);
 const oversized=Buffer.concat([png,Buffer.alloc(2*1024*1024)]);
 assert.throws(()=>validateChatImages([{...valid,data:oversized.toString('base64')}]),/2 МБ/);
});
test('stores image bytes with project, message and task ownership',async()=>{
 const recorded=[];
 const client={query:async(sql,values)=>{recorded.push({sql,values});return {rows:[]};}};
 await saveChatImages(client,{projectId:'project-id',taskId:'task-id',actorId:'actor-id',messageId:'message-id',scope:'manager'},validateChatImages([valid]));
 assert.equal(recorded.length,1);
 assert.equal(recorded[0].values[2],'task-id');
 assert.equal(recorded[0].values[3],null);
 assert.equal(recorded[0].values[4],'message-id');
 assert.deepEqual(recorded[0].values[8],png);
});
test('Codex receives private image paths which are removed after execution',async()=>{
 let imagePath='';
 await withRunnerImages([valid],async args=>{
  assert.equal(args[0],'--image');
  imagePath=args[1];
  assert.deepEqual(await readFile(imagePath),png);
 });
 await assert.rejects(access(imagePath));
 assert.deepEqual(await withRunnerImages([],async args=>args),[]);
});
