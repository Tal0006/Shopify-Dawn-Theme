import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
// Server-side sealing of Cardcom card tokens (AES-256-GCM, authenticated). The key comes only from the environment
// (GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY); there is no fallback key. The associated data binds a ciphertext to its
// database row, so a sealed token copied into another reservation does not open. Format: v1.<iv>.<tag>.<ciphertext>
// (base64url). Nothing here logs or returns the plaintext except open() to the charging code path.
export class TokenVault {
 private key:Buffer;
 constructor(key:Buffer){if(key.length!==32)throw Error('Invalid payment encryption key');this.key=Buffer.from(key);}
 seal(plain:string,aad:string):string{
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad,'utf8'));
  const data=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');
 }
 open(sealed:string,aad:string):string{
  const parts=sealed.split('.');
  if(parts.length!==4||parts[0]!=='v1')throw Error('Unsupported sealed token');
  const [iv,tag,data]=parts.slice(1).map(part=>Buffer.from(part,'base64url'));
  if(iv.length!==12||tag.length!==16||!data.length)throw Error('Unsupported sealed token');
  const decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAAD(Buffer.from(aad,'utf8'));decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');
 }
}
// 32 bytes as 64 hex characters or base64/base64url (44/43 characters). Anything else is refused (null).
export function parseEncryptionKey(value:string|undefined):Buffer|null{
 const text=value?.trim();if(!text)return null;
 if(/^[0-9a-fA-F]{64}$/.test(text))return Buffer.from(text,'hex');
 if(/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(text)){const key=Buffer.from(text.replace(/-/g,'+').replace(/_/g,'/'),'base64');return key.length===32?key:null;}
 return null;
}
