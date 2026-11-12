import type {Pool} from 'pg';
import type {AuthStore,AuthUser} from '../application/service.js';

/** Only this adapter knows session SQL and table names. */
export function createAuthRepository(db:Pick<Pool,'query'>):AuthStore{
 return {
  async findUserByEmail(email){
   const result=await db.query('SELECT * FROM users WHERE email=$1',[email]);
   return (result.rows[0] as AuthUser|undefined)??null;
  },
  async createSession(tokenHash,userId){
   await db.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[tokenHash,userId]);
  },
  async rotateSession(previousHash,nextHash){
   const result=await db.query("UPDATE auth_sessions SET token_hash=$2 WHERE token_hash=$1 AND expires_at>now() RETURNING user_id",[previousHash,nextHash]);
   return (result.rows[0]?.user_id as string|undefined)??null;
  },
  async findEmailById(userId){
   const result=await db.query('SELECT email FROM users WHERE id=$1',[userId]);
   return (result.rows[0]?.email as string|undefined)??null;
  },
  async deleteSession(tokenHash){
   await db.query('DELETE FROM auth_sessions WHERE token_hash=$1',[tokenHash]);
  }
 };
}
