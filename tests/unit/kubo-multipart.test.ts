import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMultipart } from "../../src/kubo";
import { parseMultipart } from "../helpers/multipart";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("buildMultipart", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces the exact bytes for a small file", () => {
    const body = buildMultipart("data", new TextEncoder().encode("hello"), "BOUND");
    expect(body.contentType).toBe("multipart/form-data; boundary=BOUND");
    expect(text(body.bytes)).toBe(
      '--BOUND\r\nContent-Disposition: form-data; name="data"; filename="data"\r\nContent-Type: application/octet-stream\r\n\r\nhello\r\n--BOUND--\r\n',
    );
  });

  it("is binary safe: every byte value, CRLF and dashes round-trip through a real parser", async () => {
    const data = Uint8Array.from([...Array.from({ length: 256 }, (_, i) => i), 13, 10, 45, 45, 13, 10]);
    const body = buildMultipart("data", data);
    const form = await parseMultipart({ body: body.bytes, headers: { "content-type": body.contentType } });
    const part = form.get("data");
    expect(part).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await (part as Blob).arrayBuffer())]).toEqual([...data]);
    expect([...form.keys()]).toEqual(["data"]);
  });

  it("handles an empty file", async () => {
    const body = buildMultipart("data", new Uint8Array());
    const form = await parseMultipart({ body: body.bytes, headers: { "content-type": body.contentType } });
    expect((form.get("data") as Blob).size).toBe(0);
  });

  it("refuses a requested boundary that occurs in the data", () => {
    const data = new TextEncoder().encode("xx--BOUNDyy");
    expect(() => buildMultipart("data", data, "BOUND")).toThrowError(/occurs in the data/);
  });

  it("picks another random boundary when the first one occurs in the data", () => {
    let call = 0;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      call += 1;
      array.fill(call);
      return array;
    }) as typeof crypto.getRandomValues);
    const first = `--ipfs-sync-${"01".repeat(12)}`;
    const body = buildMultipart("data", new TextEncoder().encode(`abc${first}def`));
    expect(body.contentType).toBe(`multipart/form-data; boundary=ipfs-sync-${"02".repeat(12)}`);
    expect(call).toBe(2);
  });

  it("allocates one buffer of exactly head + data + tail", () => {
    const data = new Uint8Array(1000);
    const body = buildMultipart("data", data, "B");
    expect(body.bytes.buffer.byteLength).toBe(body.bytes.length);
    expect(body.bytes.length).toBeGreaterThan(1000);
  });
});
