// Deterministic ustar + gzip writer (no shell-out, no dependency). Same inputs give the same bytes.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BLOCK = 512;
const octal = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;

function header(name, size, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path longer than 100 bytes: ${name}`);
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, "utf8");
  buf.write(octal(mode, 8), 100, "ascii");
  buf.write(octal(0, 8), 108, "ascii");
  buf.write(octal(0, 8), 116, "ascii");
  buf.write(octal(size, 12), 124, "ascii");
  buf.write(octal(0, 12), 136, "ascii"); // mtime fixed at the epoch for reproducibility
  buf.write("        ", 148, "ascii"); // checksum placeholder: eight spaces
  buf.write("0", 156, "ascii");
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");
  const sum = buf.reduce((acc, byte) => acc + byte, 0);
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return buf;
}

// entries: [{ from: absolute source path, as: archive path, mode }] in the explicit, fixed order given.
export function buildTarball(entries) {
  const parts = [];
  for (const entry of entries) {
    const bytes = readFileSync(entry.from);
    parts.push(header(entry.as, bytes.length, entry.mode), bytes, Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
