import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustodyWallet, decryptCustodyKey, encryptCustodyKey } from './agent-custody.mjs';

const masterKey = Buffer.alloc(32, 7).toString('base64');

test('custody encryption round-trips a private key and never stores it as plaintext', () => {
  const privateKey = '0x' + '11'.repeat(32);
  const encrypted = encryptCustodyKey(privateKey, masterKey);
  assert.notEqual(encrypted, privateKey);
  assert.equal(decryptCustodyKey(encrypted, masterKey), privateKey);
});

test('createCustodyWallet returns an address and encrypted key, never a plaintext key field', () => {
  const wallet = createCustodyWallet(masterKey);
  assert.match(wallet.address, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(wallet.encryptedPrivateKey.length > 40);
  assert.equal('privateKey' in wallet, false);
  assert.match(decryptCustodyKey(wallet.encryptedPrivateKey, masterKey), /^0x[0-9a-f]{64}$/i);
});

test('custody encryption rejects an invalid master key', () => {
  assert.throws(() => encryptCustodyKey('0x' + '11'.repeat(32), 'bad'), /custody_master_key_invalid/);
});
