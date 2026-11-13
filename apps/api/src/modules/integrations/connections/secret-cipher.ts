import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

/**
 * Version-one credentials envelope: 12-byte GCM IV + 16-byte authentication tag
 * + ciphertext, encoded as base64. Existing database values must remain readable.
 */
export function encryptConnectionSecret(secret:string,key:Buffer):string{
 const iv=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
}

export function decryptConnectionSecret(packedText:string,key:Buffer):string{
 const bytes=Buffer.from(packedText,'base64');
 const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 decipher.setAuthTag(bytes.subarray(12,28));
 return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
}
