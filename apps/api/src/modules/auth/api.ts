import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {SignJWT,jwtVerify} from 'jose';
import bcrypt from 'bcryptjs';
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';

const {compare}=bcrypt;

/** Signed user access token used by regular and internal authenticated routes. */
export async function issueAccessToken(jwtKey:Uint8Array,userId:string,email:string){
 return new SignJWT({email}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuedAt().setExpirationTime('12h').sign(jwtKey);
}

/** Authentication is the only owner of session rotation and cookie policy. */
export function registerAuthRoutes(app:FastifyInstance,pool:Pool,jwtKey:Uint8Array){
const REFRESH_DAYS=30;
const REFRESH_COOKIE='ado-refresh';
function refreshHash(raw:string){return createHash('sha256').update(raw).digest('hex');}
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
const accessToken=(userId:string,email:string)=>issueAccessToken(jwtKey,userId,email);
app.post('/api/login',async(req,reply)=>{
 const {email,password}=z.object({email:z.string().trim().min(3).max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),password:z.string()}).parse(req.body);
 const u=await pool.query('SELECT * FROM users WHERE email=$1',[email.toLowerCase()]);
 if(!u.rowCount || !(await compare(password,u.rows[0].password_hash))) return reply.code(401).send({error:'Неверный логин или пароль'});
 const user=u.rows[0];
 const refresh=randomBytes(32).toString('base64url');
 await pool.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[refreshHash(refresh),user.id]);
 setRefreshCookie(req,reply,refresh);
 return {token:await accessToken(user.id,user.email)};
});
app.post('/api/auth/refresh',async(req,reply)=>{
 const old=cookieValue(req,REFRESH_COOKIE);
 if(!old||!/^[a-zA-Z0-9_-]{30,100}$/.test(old))return reply.code(401).send({error:'Сессия завершена'});
 const fresh=randomBytes(32).toString('base64url');
 const rotated=await pool.query("UPDATE auth_sessions SET token_hash=$2 WHERE token_hash=$1 AND expires_at>now() RETURNING user_id",[refreshHash(old),refreshHash(fresh)]);
 if(!rotated.rowCount){setRefreshCookie(req,reply,null);return reply.code(401).send({error:'Сессия завершена'});}
 const user=(await pool.query('SELECT email FROM users WHERE id=$1',[rotated.rows[0].user_id])).rows[0];
 if(!user){setRefreshCookie(req,reply,null);return reply.code(401).send({error:'Сессия завершена'});}
 setRefreshCookie(req,reply,fresh);
 return {token:await accessToken(rotated.rows[0].user_id,user.email)};
});
app.post('/api/auth/logout',async(req,reply)=>{
 const raw=cookieValue(req,REFRESH_COOKIE);
 if(raw)await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[refreshHash(raw)]);
 setRefreshCookie(req,reply,null);
 return {ok:true};
});
app.addHook('preHandler',async(req,reply)=>{
 if(req.url === '/api/login' || req.url === '/api/health' || req.url.startsWith('/api/auth/') || !req.url.startsWith('/api/')) return;
 try {const raw=req.headers.authorization?.replace(/^Bearer /,'');if(!raw)throw Error('no token');const {payload}=await jwtVerify(raw,jwtKey);(req as any).userId=payload.sub;}
 catch{return reply.code(401).send({error:'Требуется вход'});}
});

}
