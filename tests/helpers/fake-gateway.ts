import { KuboHttpError, type GatewayRange, type GatewayStream, type KuboClient, type NodeKey } from "../../src/kubo";

export type FakeReadClient = Pick<KuboClient, "gatewayStream" | "gatewayFetch" | "nameResolve" | "keyList">;

export interface FakeGatewayOptions {
  /** Bytes per chunk the gateway sends. Default 7, to exercise buffering. */
  readonly chunkSize?: number;
  /** false: ignore Range and answer 200 with the whole object. */
  readonly honourRange?: boolean;
  /** Keys returned by `key/list`. */
  readonly keys?: readonly NodeKey[];
}

export interface FakeGateway {
  readonly client: FakeReadClient;
  /** Every request in order: `keyList`, `nameResolve <name>`, `GET <cid>/<path>[ <Range header>]`. */
  readonly requests: string[];
  /** Objects by `<cid>/<path>` (path may be empty: `<cid>`). */
  readonly objects: Map<string, Uint8Array>;
  /** IPNS name (as passed) to `/ipfs/<cid>`. */
  readonly names: Map<string, string>;
  /** Highest number of streams open at the same time, and how many are open right now. */
  stats: { maxInFlight: number; inFlight: number };
  /** Ranges requested, in order, as `[start, length]`. */
  readonly ranges: (readonly [number, number])[];
  /** Serve fewer bytes than the object has, for paths matching. */
  truncate: RegExp | undefined;
  /** Break the stream after the first chunk, for paths matching. */
  breakStream: RegExp | undefined;
  /** Replace the served bytes, for paths matching (a hostile or corrupt gateway). */
  corrupt: RegExp | undefined;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

function slices(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) out.push(data.slice(offset, offset + size));
  return out;
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const requests: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const names = new Map<string, string>();
  const ranges: (readonly [number, number])[] = [];
  const chunkSize = options.chunkSize ?? 7;
  const gateway: FakeGateway = { client: undefined as unknown as FakeReadClient, requests, objects, names, ranges, stats: { maxInFlight: 0, inFlight: 0 }, truncate: undefined, breakStream: undefined, corrupt: undefined };

  function locate(cid: string, path: string): Uint8Array {
    const found = objects.get(path === "" ? cid : `${cid}/${path}`);
    if (found === undefined) throw new KuboHttpError("gateway", "https://gw.test", 404, "not found");
    return found;
  }

  async function* body(path: string, data: Uint8Array): AsyncGenerator<Uint8Array> {
    gateway.stats.inFlight += 1;
    gateway.stats.maxInFlight = Math.max(gateway.stats.maxInFlight, gateway.stats.inFlight);
    try {
      let bytes = data;
      if (gateway.corrupt?.test(path) === true) bytes = data.map((b) => b ^ 0xff);
      if (gateway.truncate?.test(path) === true) bytes = bytes.slice(0, Math.max(0, bytes.length - 3));
      let sent = 0;
      for (const chunk of slices(bytes, chunkSize)) {
        await tick();
        if (sent > 0 && gateway.breakStream?.test(path) === true) throw new Error("connection reset");
        sent += 1;
        yield chunk;
      }
    } finally {
      gateway.stats.inFlight -= 1;
    }
  }

  const client: FakeReadClient = {
    keyList: async () => {
      requests.push("keyList");
      return (options.keys ?? []).map((key) => ({ ...key }));
    },
    nameResolve: async (name) => {
      requests.push(`nameResolve ${name}`);
      const value = names.get(name.replace("/ipns/", ""));
      if (value === undefined) throw new KuboHttpError("rpc", "https://rpc.test", 500, "could not resolve name");
      return value;
    },
    gatewayFetch: async (cid, path = "") => {
      requests.push(`GET ${cid}${path === "" ? "" : `/${path}`}`);
      return Uint8Array.from(locate(cid, path));
    },
    gatewayStream: async (cid, path = "", range?: GatewayRange): Promise<GatewayStream> => {
      requests.push(`GET ${cid}${path === "" ? "" : `/${path}`}${range === undefined ? "" : ` Range: bytes=${range.start}-${range.start + range.length - 1}`}`);
      const whole = locate(cid, path);
      if (range !== undefined && options.honourRange !== false) {
        ranges.push([range.start, range.length]);
        const part = whole.slice(range.start, range.start + range.length);
        return {
          status: 206,
          contentRange: `bytes ${range.start}-${range.start + part.length - 1}/${whole.length}`,
          chunks: body(path, part),
        };
      }
      return { status: 200, contentRange: undefined, chunks: body(path, whole) };
    },
  };
  return Object.assign(gateway, { client });
}
