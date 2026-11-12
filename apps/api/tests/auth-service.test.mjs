import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {createHash} from 'node:crypto';
import {jwtVerify} from 'jose';
import {createAuthService} from '../dist/modules/auth/application/service.js';

const key=new TextEncoder().encode('test-auth-secret-at-least-thirty-two-bytes');
const hash=value=>createHash('sha256').update(value).digest('hex');

test('auth application owns verification and refresh rotation through its port',async()=>{
 const digest=await bcrypt.hash('secret-password',4);
 const calls=[];
 const store={
  async findUserByEmail(email){calls.push(['find',email]);return {id:'user-1',email,password_hash:digest}},
  async createSession(tokenHash,userId){calls.push(['create',tokenHash,userId])},
  async rotateSession(oldHash,newHash){calls.push(['rotate',oldHash,newHash]);return 'user-1'},
  async findEmailById(userId){calls.push(['email',userId]);return 'owner@example.test'},
  async deleteSession(tokenHash){calls.push(['delete',tokenHash])}
 };
 const auth=createAuthService(store,key);
 assert.equal(await auth.login('OWNER@EXAMPLE.TEST','incorrect'),null);
 assert.equal(calls.some(c=>c[0]==='create'),false);
 const login=await auth.login('OWNER@EXAMPLE.TEST','secret-password');
 assert.equal(calls.filter(c=>c[0]==='create').length,1);
 assert.equal(calls.find(c=>c[0]==='create')[1],hash(login.refresh));
 assert.equal((await jwtVerify(login.token,key)).payload.sub,'user-1');
 const rotated=await auth.rotate(login.refresh);
 assert.equal(calls.find(c=>c[0]==='rotate')[1],hash(login.refresh));
 assert.equal(calls.find(c=>c[0]==='rotate')[2],hash(rotated.refresh));
 assert.notEqual(rotated.refresh,login.refresh);
 await auth.logout(rotated.refresh);
 assert.equal(calls.find(c=>c[0]==='delete')[1],hash(rotated.refresh));
});

test('auth application declines unavailable accounts without fabricating a session',async()=>{
 const store={
  findUserByEmail:async()=>null,
  createSession:async()=>{throw Error('Must not create session')},
  rotateSession:async()=>null,
  findEmailById:async()=>null,
  deleteSession:async()=>{}
 };
 const auth=createAuthService(store,key);
 assert.equal(await auth.login('missing@example.test','none'),null);
 assert.equal(await auth.rotate('unknown-token'),null);
});
