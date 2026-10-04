import { sha256Hex } from "../../src/sync/hash";

export const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
export const decode = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

export async function sha(text: string | Uint8Array): Promise<string> {
  return sha256Hex(typeof text === "string" ? encode(text) : Uint8Array.from(text));
}

/** A syntactically valid CID-looking token (the client only checks the shape). */
export const FAKE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

export const IPNS_NAME = "k51qzi5uqu5dtestpullname0000000000000000000000000000";
