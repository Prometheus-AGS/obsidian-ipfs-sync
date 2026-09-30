export type ConfigErrorCode =
  | "invalid-url"
  | "invalid-port"
  | "port-conflict"
  | "invalid-auth"
  | "unsafe-mfs-root"
  | "unsafe-mfs-path"
  | "invalid-key-name"
  | "foreign-key"
  | "secret-in-config-file"
  | "invalid-config-file"
  | "fixture-marker-required";

/** Thrown when configuration is invalid or unsafe. Never carries secret values. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}
