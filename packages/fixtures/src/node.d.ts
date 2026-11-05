// Minimal typings for the Node built-ins this package uses. The workspace
// does not depend on @types/node; if it ever does, delete this file.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function writeFile(path: string, data: Uint8Array): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  export function readdir(path: string, options?: { recursive?: boolean }): Promise<string[]>;
  export function stat(path: string): Promise<{ isDirectory(): boolean }>;
}

interface ImportMeta {
  /** Directory of the current module (Node 20.11+). */
  readonly dirname: string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module "node:zlib" {
  export function inflateSync(data: Uint8Array): Uint8Array;
  export function deflateSync(data: Uint8Array): Uint8Array;
}
