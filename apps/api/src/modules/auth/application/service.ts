import bcrypt from 'bcryptjs';
import {createHash,randomBytes} from 'node:crypto';
import {issueAccessToken} from './tokens.js';

export type AuthUser={id:string;email:string;password_hash:string};

/** Database port owned by the application; infrastructure provides the adapter. */
export interface AuthStore{
 findUserByEmail(email:string):Promise<AuthUser|null>;
 createSession(tokenHash:string,userId:string):Promise<void>;
 rotateSession(previousHash:string,nextHash:string):Promise<string|null>;
 findEmailById(userId:string):Promise<string|null>;
 deleteSession(tokenHash:string):Promise<void>;
}
const refreshHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const refreshToken=()=>randomBytes(32).toString('base64url');

export function createAuthService(store:AuthStore,jwtKey:Uint8Array){
 return {
  async login(email:string,password:string){
   const user=await store.findUserByEmail(email.toLowerCase());
   if(!user||!await bcrypt.compare(password,user.password_hash))return null;
   const refresh=refreshToken();
   await store.createSession(refreshHash(refresh),user.id);
   return {refresh,token:await issueAccessToken(jwtKey,user.id,user.email)};
  },
  async rotate(raw:string){
   const fresh=refreshToken();
   const userId=await store.rotateSession(refreshHash(raw),refreshHash(fresh));
   if(!userId)return null;
   const email=await store.findEmailById(userId);
   if(!email)return null;
   return {refresh:fresh,token:await issueAccessToken(jwtKey,userId,email)};
  },
  async logout(raw:string){
   await store.deleteSession(refreshHash(raw));
  }
 };
}
