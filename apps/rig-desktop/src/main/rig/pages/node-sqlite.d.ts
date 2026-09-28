// Node's built-in SQLite (Node 22.5+, Electron 40's Node 24) isn't in this
// project's @types/node yet: just the calls the Chrome sign-in import (and
// its fixture databases in tests) use.
declare module 'node:sqlite' {
  interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
