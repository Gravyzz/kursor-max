/**
 * Замена node:crypto для браузера. Серверный код использует только HMAC-SHA256,
 * случайные байты и сравнение за постоянное время — этого достаточно.
 * digest() без кодировки возвращает Buffer: код QR-отметки читает из него байты.
 */
import { Buffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

const encoder = new TextEncoder();
type Data = string | Uint8Array;
const bytes = (value: Data) => (typeof value === 'string' ? encoder.encode(value) : value);

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createHmac(algorithm: string, key: Data) {
  if (algorithm !== 'sha256') throw new Error(`Алгоритм ${algorithm} в демо не поддерживается`);
  const chunks: Uint8Array[] = [];
  const api = {
    update(data: Data) {
      chunks.push(bytes(data));
      return api;
    },
    digest(encoding?: 'hex' | 'base64' | 'base64url') {
      const out = Buffer.from(hmac(sha256, bytes(key), concat(chunks)));
      return (encoding ? out.toString(encoding) : out) as never;
    },
  };
  return api;
}

export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error(`Алгоритм ${algorithm} в демо не поддерживается`);
  const chunks: Uint8Array[] = [];
  const api = {
    update(data: Data) {
      chunks.push(bytes(data));
      return api;
    },
    digest(encoding?: 'hex' | 'base64' | 'base64url') {
      const out = Buffer.from(sha256(concat(chunks)));
      return (encoding ? out.toString(encoding) : out) as never;
    },
  };
  return api;
}

export function randomBytes(size: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export default { createHmac, createHash, randomBytes, timingSafeEqual, randomUUID };
