import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import {createHash} from 'node:crypto';
import {jwtVerify} from 'jose';
import {registerAuthRoutes} from '../dist/modules/auth/api.js';

const secret=new TextEncoder().encode('test-signing-secret-long-enough-for-hs256');
const digest=value=>createHash('sha256').update(value).digest('hex');

async function fixture(){
 const passwordHash=await bcrypt.hash('correct-password',4);
 const user={id:'user-1',email:'owner@example.test',password_hash:passwordHash};
 const sessions=new Map();
 const pool={query:async(sql,args=[])=>{
  const text=String(sql);
  if(text.startsWith('SELECT * FROM users WHERE email='))return {rowCount:args[0]===user.email?1:0,rows:args[0]===user.email?[user]:[]};
  if(text.startsWith('INSERT INTO auth_sessions')){sessions.set(args[0],user.id);return {rowCount:1,rows:[]}};
  if(text.startsWith('UPDATE auth_sessions')){
   const id=sessions.get(args[0]);
   if(!id)return {rowCount:0,rows:[]};
   sessions.delete(args[0]);sessions.set(args[1],id);
   return {rowCount:1,rows:[{user_id:id}]};
  }
  if(text.startsWith('SELECT email FROM users WHERE id='))return {rowCount:1,rows:[{email:user.email}]};
  if(text.startsWith('DELETE FROM auth_sessions')){sessions.delete(args[0]);return {rowCount:1,rows:[]}};
  throw new Error('Unexpected query '+text);
 }};
 const app=Fastify();
 registerAuthRoutes(app,pool,secret);
 app.get('/api/protected',async request=>({userId:request.userId}));
 await app.ready();
 return {app,sessions,user};
}
test('login, refresh rotation, JWT guard and logout share one authenticated contract',async()=>{
 const {app,sessions,user}=await fixture();
 try{
  const bad=await app.inject({method:'POST',url:'/api/login',payload:{email:user.email,password:'incorrect'}});
  assert.equal(bad.statusCode,401);
  const before=await app.inject({url:'/api/protected'});
  assert.equal(before.statusCode,401);
  const login=await app.inject({method:'POST',url:'/api/login',payload:{email:'OWNER@example.test',password:'correct-password'}});
  assert.equal(login.statusCode,200);
  const {token}=login.json();
  const claim=await jwtVerify(token,secret);
  assert.equal(claim.payload.sub,user.id);
  const refreshCookie=login.headers['set-cookie'].split(';')[0];
  assert.match(refreshCookie,/^ado-refresh=/);
  assert.equal(sessions.has(digest(refreshCookie.slice('ado-refresh='.length))),true);
  const authed=await app.inject({url:'/api/protected',headers:{Authorization:'Bearer '+token}});
  assert.equal(authed.statusCode,200);
  assert.equal(authed.json().userId,user.id);
  const rotated=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{cookie:refreshCookie}});
  assert.equal(rotated.statusCode,200);
  assert.equal(sessions.size,1);
  const replay=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{cookie:refreshCookie}});
  assert.equal(replay.statusCode,401);
  const freshCookie=rotated.headers['set-cookie'].split(';')[0];
  const logout=await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:freshCookie}});
  assert.equal(logout.statusCode,200);
  assert.equal(sessions.size,0);
 }finally{await app.close();}
});
test('refresh cookie keeps HTTP-only and path restrictions',async()=>{
 const {app,user}=await fixture();
 try{
  const login=await app.inject({method:'POST',url:'/api/login',payload:{email:user.email,password:'correct-password'},headers:{'x-forwarded-proto':'https'}});
  const cookie=login.headers['set-cookie'];
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/SameSite=Lax/);
  assert.match(cookie,/Path=\/api\/auth/);
  assert.match(cookie,/Secure/);
 }finally{await app.close();}
});
