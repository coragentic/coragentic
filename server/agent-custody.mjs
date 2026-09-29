import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

function keyBytes(masterKey) {
  let bytes;
  try { bytes = Buffer.from(String(masterKey), 'base64'); } catch { bytes = Buffer.alloc(0); }
  if (bytes.length !== 32) throw new Error('custody_master_key_invalid');
  return bytes;
}

// AES-256-GCM envelope: v1.<iv base64url>.<tag base64url>.<ciphertext base64url>
// The database never receives the raw private key. Master key is sourced from
// the service environment only and is deliberately never serialized in API
// responses, audit payloads, UI, or git.
export function encryptCustodyKey(privateKey, masterKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptCustodyKey(envelope, masterKey) {
  const [version, iv, tag, ciphertext] = String(envelope).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('custody_envelope_invalid');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(masterKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export function createCustodyWallet(masterKey) {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return { address, encryptedPrivateKey: encryptCustodyKey(privateKey, masterKey) };
}
