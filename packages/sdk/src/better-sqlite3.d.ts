// Type declaration for better-sqlite3 (no @types package needed)
declare module 'better-sqlite3' {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface ColumnDefinition {
    name: string;
    column: string | null;
    type: string | null;
    notnull: boolean;
    dflt_value: string | null;
    pk: boolean;
  }

  interface Statement<BindParameters extends unknown[] = unknown[], Result = unknown> {
    database: Database;
    source: string;
    reader: boolean;
    readonly: boolean;
    busy: boolean;
    run(...params: BindParameters): RunResult;
    get(...params: BindParameters): Result | undefined;
    all(...params: BindParameters): Result[];
    iterate(...params: BindParameters): IterableIterator<Result>;
    pluck(toggleState?: boolean): this;
    expand(toggleState?: boolean): this;
    raw(toggleState?: boolean): this;
    bind(...params: BindParameters): this;
    columns(): ColumnDefinition[];
    safeIntegers(toggleState?: boolean): this;
  }

  class Database {
    constructor(
      filename: string,
      options?: {
        readonly?: boolean;
        fileMustExist?: boolean;
        timeout?: number;
        verbose?: ((sql: string) => void) | null;
      },
    );
    prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(
      sql: string,
    ): Statement<BindParameters, Result>;
    exec(sql: string): this;
    transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    checkpoint(namespace?: string): this;
    function(name: string, func: (...args: unknown[]) => unknown): this;
    function(
      name: string,
      options: { deterministic?: boolean; vararg?: boolean },
      func: (...args: unknown[]) => unknown,
    ): this;
    aggregate(
      name: string,
      options: {
        start?: unknown;
        step: (total: unknown, next: unknown) => unknown;
        inverse?: (total: unknown, dropped: unknown) => unknown;
        result?: (total: unknown) => unknown;
        deterministic?: boolean;
        vararg?: boolean;
      },
    ): this;
    backup(
      destination: string,
      options?: {
        attached?: string;
        pages?: number;
        progress?: (remaining: number, total: number) => 'continue' | 'stop';
      },
    ): Promise<void>;
    close(): this;
    defaultSafeIntegers(toggleState?: boolean): this;
    readonly open: boolean;
    readonly inTransaction: boolean;
    readonly readonly: boolean;
    readonly memory: boolean;
    readonly name: string;
  }

  export = Database;
}
