// Minimal typings for the two Node built-ins this package uses. The workspace
// does not depend on @types/node; if it ever does, delete this file.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
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
