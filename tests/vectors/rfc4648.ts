/**
 * RFC 4648 section 10, test vectors for BASE64 and BASE32. Source: https://www.rfc-editor.org/rfc/rfc4648#section-10
 * (IETF, October 2006). Transcribed from memory of the RFC text (no network access in this task).
 * The base32 rows are the RFC's upper-case padded strings; the module under test emits lower-case unpadded
 * text, so the test maps between the two forms.
 */
export interface Rfc4648Vector {
  readonly input: string;
  readonly base64: string;
  readonly base32: string;
}

export const RFC4648_VECTORS: readonly Rfc4648Vector[] = [
  { input: "", base64: "", base32: "" },
  { input: "f", base64: "Zg==", base32: "MY======" },
  { input: "fo", base64: "Zm8=", base32: "MZXQ====" },
  { input: "foo", base64: "Zm9v", base32: "MZXW6===" },
  { input: "foob", base64: "Zm9vYg==", base32: "MZXW6YQ=" },
  { input: "fooba", base64: "Zm9vYmE=", base32: "MZXW6YTB" },
  { input: "foobar", base64: "Zm9vYmFy", base32: "MZXW6YTBOI======" },
];
