// Minimal shims for Node.js types used in this project when @types/node is unavailable.

type Buffer = any;

declare const Buffer: {
  byteLength(str: string, encoding?: string): number;
};

declare function require(id: string): any;
declare namespace require {
  function resolve(id: string): string;
}

declare const process: {
  pid?: number;
  kill(signal?: string): void;
  stdin?: { write(data: string): void; destroyed?: boolean } | null;
  stdout?: unknown;
  stderr?: unknown;
  execPath: string;
  env?: Record<string, string | undefined>;
  cwd?: () => string;
};

declare module 'child_process' {
  export type ChildProcess = {
    pid?: number;
    killed: boolean;
    stdin?: { write(data: string): void; destroyed?: boolean } | null;
    stdout?: { on(event: string, listener: (chunk: any) => void): void } | null;
    stderr?: { on(event: string, listener: (chunk: any) => void): void } | null;
    kill(signal?: string): void;
    on(event: string, listener: (...args: any[]) => void): void;
  };

  export function spawn(command: string, args?: ReadonlyArray<string>, options?: any): ChildProcess;
}

declare module 'readline' {
  export function createInterface(options: any): {
    on(event: string, listener: (...args: any[]) => void): void;
    close(): void;
  };
}

