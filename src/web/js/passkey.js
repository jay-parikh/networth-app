// Unlock with the device's own screen lock (Face ID, Touch ID, fingerprint,
// PIN or pattern) instead of typing the Lock password.
//
// How: a passkey for this site lives in the phone's keychain (iCloud Keychain
// on iPhone/iPad, Google Password Manager on Android). Its PRF extension gives
// a 32-byte secret, but only after the phone has checked the person with its
// screen lock. That secret (through HKDF) is an AES-GCM key which seals a copy
// of the Lock password, kept in this device's storage as kv 'passkey':
//   { credId, prfSalt, iv, data, created }
// Unlocking asks the passkey for the secret, opens the copy and unlocks
// exactly as if the password had been typed. Without the passkey and the
// person's face/finger/PIN the copy cannot be opened. The password keeps
// working everywhere (other devices, exported Excel files, the desktop app).
//
// Needs the PRF extension: iOS/iPadOS 18+, Android with a recent Chrome, or a
// desktop browser whose passkey provider supports it.
import * as store from './store.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const INFO = enc.encode('NetWorth passkey unlock v1');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export class PasskeyError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// What this device calls its screen lock, for labels.
export function lockName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'Face ID / Touch ID';
  if (/Android/.test(ua)) return 'fingerprint or screen lock';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return 'device lock';
}

// A passkey on this device is possible at all (PRF support is only known
// for sure once one is made).
export async function available() {
  try {
    if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) return false;
    if (PublicKeyCredential.getClientCapabilities) {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && caps['extension:prf'] === false) return false;
    }
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    return false;
  }
}

async function sealKey(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: INFO },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function asError(e) {
  if (e instanceof PasskeyError) return e;
  if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
    return new PasskeyError('cancelled', 'Cancelled.');
  }
  if (e && e.name === 'InvalidStateError') return new PasskeyError('exists', 'This device already has a passkey for NetWorth.');
  return new PasskeyError('failed', (e && e.message) || 'The device lock did not answer.');
}

// Every WebAuthn call below is the FIRST await of its function, so it runs
// inside the tap that started it - iPhone/iPad refuse Face ID otherwise.

// Ask the passkey for its secret (shows Face ID / fingerprint / PIN).
export async function secret(rec) {
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: rec.credId }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: rec.prfSalt } } },
    } });
  } catch (e) { throw asError(e); }
  const out = cred && cred.getClientExtensionResults().prf;
  const first = out && out.results && out.results.first;
  if (!first) throw noPrf();
  return new Uint8Array(first);
}

const noPrf = () => new PasskeyError('noprf', 'This device\'s passkeys cannot unlock encrypted data. It needs iOS / iPadOS 18 or newer, or a recent Chrome on Android. Keep using your password.');

// Step 1 of turning it on: make the passkey. Returns { credId, prfSalt,
// secret } - secret is null on iPhone/iPad, which hand it out only when the
// passkey is used (step 2: secret(rec), after another tap).
export async function create() {
  const prfSalt = rand(32);
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'NetWorth' },
      user: { id: rand(16), name: `NetWorth (${deviceLabel()})`, displayName: `NetWorth (${deviceLabel()})` },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } },
    } });
  } catch (e) { throw asError(e); }
  const ext = cred.getClientExtensionResults().prf;
  if (!ext || ext.enabled === false) throw noPrf();
  return { credId: new Uint8Array(cred.rawId), prfSalt,
    secret: ext.results && ext.results.first ? new Uint8Array(ext.results.first) : null };
}

// Seal the Lock password with the passkey's secret and keep it on the device.
export async function sealPassword(rec, sec, password) {
  const key = await sealKey(sec);
  const iv = rand(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(password)));
  const saved = { credId: rec.credId, prfSalt: rec.prfSalt, iv, data, created: new Date().toISOString() };
  await store.kvSet('passkey', saved);
  return saved;
}

// The Lock password, from the passkey's secret.
export async function openPassword(rec, sec) {
  try {
    const key = await sealKey(sec);
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.data));
  } catch (e) {
    throw new PasskeyError('mismatch', 'This passkey does not match the one set up here. Use your password, then turn the device unlock on again in Settings.');
  }
}

// The saved record (null when it is off). Load it before the tap that uses it.
export async function load() {
  try { return (await store.kvGet('passkey')) || null; } catch (e) { return null; }
}

// Forget the sealed copy. (The passkey itself stays in the phone's
// password list until the person deletes it there.)
export async function disable() {
  await store.kvDel('passkey');
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  return 'this device';
}
