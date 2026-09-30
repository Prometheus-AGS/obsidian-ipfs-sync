/** Parse a multipart request body the way a server would (Node's own Response parser). */
export async function parseMultipart(init: RequestInit): Promise<FormData> {
  return new Response(init.body, { headers: init.headers }).formData();
}

/** The bytes of the multipart part named `data`. */
export async function dataPart(init: RequestInit): Promise<Uint8Array<ArrayBuffer>> {
  const part = (await parseMultipart(init)).get("data");
  if (!(part instanceof Blob)) throw new Error("no multipart part named data");
  return new Uint8Array(await part.arrayBuffer());
}
