import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {jwtVerify} from 'jose';
import {z} from 'zod';
import {createAuthService} from './application/service.js';
import {createAuthRepository} from './infrastructure/auth-repository.js';

/** HTTP owns validation, cookies and status codes; the service owns sessions. */
export function registerAuthRoutes(app:FastifyInstance,pool:Pool,jwtKey:Uint8Array){
 const auth=createAuthService(createAuthRepository(pool),jwtKey);
 const REFRESH_DAYS=30;
 const REFRESH_COOKIE='ado-refresh';
 function cookieValue(req:any,name:string){
  const line=String(req.headers.cookie||'');
  const item=line.split(';').map((x:string)=>x.trim()).find((x:string)=>x.startsWith(name+'='));
  return item?item.slice(name.length+1):null;
 }
 function setRefreshCookie(req:any,reply:any,raw:string|null){
  const secure=req.protocol==='https'||req.headers['x-forwarded-proto']==='https';
  const value=raw?encodeURIComponent(raw):'';
  const attrs=[REFRESH_COOKIE+'='+value,'HttpOnly','SameSite=Lax','Path=/api/auth',secure?'Secure':'',raw?'Max-Age='+REFRESH_DAYS*86400:'Max-Age=0'].filter(Boolean);
  reply.header('Set-Cookie',attrs.join('; '));
 }
 app.post('/api/login',async(req,reply)=>{
  const {email,password}=z.object({email:z.string().trim().min(3).max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),password:z.string()}).parse(req.body);
  const result=await auth.login(email,password);
  if(!result)return reply.code(401).send({error:'Неверный логин или пароль'});
  setRefreshCookie(req,reply,result.refresh);
  return {token:result.token};
 });
 app.post('/api/auth/refresh',async(req,reply)=>{
  const old=cookieValue(req,REFRESH_COOKIE);
  if(!old||!/^[a-zA-Z0-9_-]{30,100}$/.test(old))return reply.code(401).send({error:'Сессия завершена'});
  const result=await auth.rotate(old);
  if(!result){setRefreshCookie(req,reply,null);return reply.code(401).send({error:'Сессия завершена'});}
  setRefreshCookie(req,reply,result.refresh);
  return {token:result.token};
 });
 app.post('/api/auth/logout',async(req,reply)=>{
  const raw=cookieValue(req,REFRESH_COOKIE);
  if(raw)await auth.logout(raw);
  setRefreshCookie(req,reply,null);
  return {ok:true};
 });
 app.addHook('preHandler',async(req,reply)=>{
  if(req.url === '/api/login' || req.url === '/api/health' || req.url.startsWith('/api/auth/') || !req.url.startsWith('/api/')) return;
  try {const raw=req.headers.authorization?.replace(/^Bearer /,'');if(!raw)throw Error('no token');const {payload}=await jwtVerify(raw,jwtKey);(req as any).userId=payload.sub;}
  catch{return reply.code(401).send({error:'Требуется вход'});}
 });
}
