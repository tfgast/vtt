// Minimal typings for the Node built-ins the scenario loader uses beyond
// test/node.d.ts. The formula package does not load @types/node; if it ever
// does, delete this file.
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

interface ImportMeta {
  /** Resolve a module specifier to a URL string (Node 20.6+). */
  resolve(specifier: string): string;
}
