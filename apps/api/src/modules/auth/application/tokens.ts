import {SignJWT} from 'jose';

/** Common 12-hour user JWT issuer; internal short-lived worker tokens stay separate. */
export function issueAccessToken(jwtKey:Uint8Array,userId:string,email:string):Promise<string>{
 return new SignJWT({email}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuedAt().setExpirationTime('12h').sign(jwtKey);
}
