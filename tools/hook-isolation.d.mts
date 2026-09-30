export const TESTING_DIR: string;
export const RESTRICTED_SYMBOLS: Readonly<Record<string, readonly string[]>>;
export const INJECTION_NAMES: Readonly<Record<string, readonly string[]>>;
export const BOUNDARY_EXCEPTIONS: readonly string[];
export const SOURCE_FILE: RegExp;

export interface SentinelEntry {
  readonly file: string;
  readonly sentinel: string;
}

export interface BuiltGraph {
  readonly label: string;
  readonly inputs: readonly string[];
  readonly text: string;
}

export interface IsolationReport {
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly sentinels: readonly SentinelEntry[];
  readonly graphs: readonly { readonly label: string; readonly inputs: number; readonly bytes: number }[];
}

export interface DistReport {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly missing: readonly string[];
  readonly violations: readonly string[];
}

export function loadSentinels(root?: string): Promise<SentinelEntry[]>;
export function findViolations(graph: BuiltGraph, sentinels: readonly SentinelEntry[]): string[];
export function checkHookIsolation(options?: {
  readonly root?: string;
  readonly extraEntries?: readonly { readonly label: string; readonly contents: string }[];
}): Promise<IsolationReport>;
export function checkDistBundles(options?: { readonly root?: string }): Promise<DistReport>;
export function findTestingImports(
  files: readonly { readonly path: string; readonly text: string }[],
  root?: string,
  options?: { readonly shipped?: boolean },
): string[];
export function findInjectionLeaks(files: readonly { readonly path: string; readonly text: string }[], root?: string): string[];
export function findBoundaryImports(files: readonly { readonly path: string; readonly text: string }[], root?: string): string[];
export function lintTestingImports(root?: string): Promise<string[]>;
