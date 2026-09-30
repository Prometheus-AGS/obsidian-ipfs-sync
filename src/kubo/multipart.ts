/**
 * A multipart/form-data body built by hand, as one buffer. Obsidian's `requestUrl` cannot send `FormData`,
 * and building the bytes ourselves makes the CLI (`fetch`) and the plugin (`requestUrl`) send the same request.
 * The file bytes are copied once, into the final buffer.
 */
export interface MultipartBody {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Includes the boundary: send it as the `Content-Type` header. */
  readonly contentType: string;
}

const BOUNDARY_ATTEMPTS = 8;
const BOUNDARY_RANDOM_BYTES = 12;

function randomBoundary(): string {
  const random = crypto.getRandomValues(new Uint8Array(BOUNDARY_RANDOM_BYTES));
  return `ipfs-sync-${Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** True when `needle` occurs in `data`. */
function contains(data: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  for (let at = data.indexOf(first ?? 0); at !== -1 && at + needle.length <= data.length; at = data.indexOf(first ?? 0, at + 1)) {
    if (needle.every((byte, offset) => data[at + offset] === byte)) return true;
  }
  return false;
}

function freeBoundary(data: Uint8Array, requested: string | undefined): string {
  const encoder = new TextEncoder();
  if (requested !== undefined) {
    if (contains(data, encoder.encode(`--${requested}`))) throw new Error(`multipart boundary "${requested}" occurs in the data`);
    return requested;
  }
  for (let attempt = 0; attempt < BOUNDARY_ATTEMPTS; attempt += 1) {
    const candidate = randomBoundary();
    if (!contains(data, encoder.encode(`--${candidate}`))) return candidate;
  }
  throw new Error("could not find a multipart boundary that is absent from the data");
}

/**
 * One file part named `field` (the proxy in front of the node requires `data`), filename equal to the field,
 * type application/octet-stream. `boundary` is for tests; by default a random one that does not occur in `data`.
 */
export function buildMultipart(field: string, data: Uint8Array, boundary?: string): MultipartBody {
  const chosen = freeBoundary(data, boundary);
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${chosen}\r\nContent-Disposition: form-data; name="${field}"; filename="${field}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${chosen}--\r\n`);
  const bytes = new Uint8Array(head.length + data.length + tail.length);
  bytes.set(head, 0);
  bytes.set(data, head.length);
  bytes.set(tail, head.length + data.length);
  return { bytes, contentType: `multipart/form-data; boundary=${chosen}` };
}
