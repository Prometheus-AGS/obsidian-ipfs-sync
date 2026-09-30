import type { Bytes } from "../core/host-bridge";

const CHUNK = 0x8000;

/** Standard base64 of the bytes (WebView `btoa`; no Node Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)));
  }
  return btoa(parts.join(""));
}

/** Inverse of `bytesToBase64`. Throws on text that is not base64. */
export function base64ToBytes(text: string): Bytes {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
