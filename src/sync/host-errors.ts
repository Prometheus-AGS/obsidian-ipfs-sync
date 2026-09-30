/** Raised by a host for a capability family it does not provide (for example `net_fetch` on the CLI). */
export class HostNotImplementedError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`${capability} is not implemented in this host`);
    this.name = "HostNotImplementedError";
    this.capability = capability;
  }
}

/** A path handed to a host would leave its root, or is malformed. */
export class HostPathError extends Error {
  constructor(path: string, reason: string) {
    super(`host path "${path}" refused: ${reason}`);
    this.name = "HostPathError";
  }
}

/** Raised by a host for a capability it refuses on purpose (for example `shell_exec` in the Obsidian plugin). */
export class HostDeniedError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`${capability} is denied in this host`);
    this.name = "HostDeniedError";
    this.capability = capability;
  }
}

/**
 * A host refused to load a file that is larger than its read cap (Obsidian's adapter cannot read part of a
 * file, so a read loads all of it). The message names the file and the cap; it carries no file content.
 */
export class HostReadCapError extends Error {
  readonly path: string;
  readonly sizeBytes: number;
  readonly capBytes: number;

  constructor(path: string, sizeBytes: number, capBytes: number) {
    const megabytes = (bytes: number): string => `${Math.ceil(bytes / (1024 * 1024))} MB`;
    super(`"${path}" is ${megabytes(sizeBytes)}, above the read cap of ${megabytes(capBytes)}`);
    this.name = "HostReadCapError";
    this.path = path;
    this.sizeBytes = sizeBytes;
    this.capBytes = capBytes;
  }
}
