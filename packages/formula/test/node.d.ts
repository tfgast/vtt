// Minimal typings for the Node built-ins the scenario discovery test uses.
// The formula package is pure and does not load @types/node; if it ever does,
// delete this file.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
}

interface ImportMeta {
  /** Directory of the current module (Node 20.11+). */
  readonly dirname: string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
