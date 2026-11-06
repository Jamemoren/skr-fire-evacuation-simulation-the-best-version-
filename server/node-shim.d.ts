/**
 * Minimal type declarations for the Node.js built-ins the incident server uses. The project has no
 * @types/node dependency (installing it would touch the shared node_modules), so only the small
 * surface used here is declared. Runtime is plain Node.js ≥ 20.
 */
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  pid: number;
  exitCode?: number;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code?: number): never;
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  uptime(): number;
  hrtime: { bigint(): bigint };
};

declare class Buffer extends Uint8Array {
  static from(data: string | Uint8Array | ArrayBuffer, encoding?: string): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static byteLength(data: string): number;
  toString(encoding?: string): string;
}

declare function setInterval(handler: () => void, ms: number): { unref(): void };
declare function clearInterval(handle: { unref(): void } | undefined): void;
declare function setTimeout(handler: () => void, ms: number): { unref(): void };
declare function clearTimeout(handle: { unref(): void } | undefined): void;
declare function setImmediate(handler: () => void): unknown;
declare const require: (id: string) => unknown;
declare const __dirname: string;

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "end" | "close" | "aborted", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    destroy(): void;
  }
  export interface ServerResponse {
    statusCode: number;
    headersSent: boolean;
    writableEnded: boolean;
    setHeader(name: string, value: string | number | string[]): void;
    writeHead(status: number, headers?: Record<string, string | number>): this;
    write(chunk: string | Uint8Array): boolean;
    end(chunk?: string | Uint8Array): void;
    on(event: "close", listener: () => void): this;
    flushHeaders?(): void;
  }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    close(callback?: () => void): void;
    on(event: "error", listener: (error: Error & { code?: string }) => void): this;
    address(): { port: number } | string | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
  export function request(url: string, options: Record<string, unknown>, callback: (res: IncomingMessage & { statusCode?: number }) => void): {
    on(event: "error", listener: (error: Error) => void): void; write(data: string): void; end(): void; destroy(): void;
  };
}

declare module "node:https" {
  import type { IncomingMessage, Server, ServerResponse } from "node:http";
  export function createServer(options: { key: Buffer; cert: Buffer }, handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number };
  export function unlinkSync(path: string): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function extname(path: string): string;
  export function normalize(path: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare module "node:crypto" {
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function createHash(algorithm: "sha256"): { update(data: string): { digest(encoding: "hex"): string } };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:os" {
  export function networkInterfaces(): Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;
}

declare class URL {
  constructor(input: string, base?: string);
  pathname: string;
  search: string;
  searchParams: { get(name: string): string | null };
}

declare const console: { log(...values: unknown[]): void; error(...values: unknown[]): void; warn(...values: unknown[]): void };
