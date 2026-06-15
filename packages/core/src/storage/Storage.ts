export interface Storage {
  /** Read raw string content at a key, or null if absent. */
  read(key: string): Promise<string | null>;
  /** Write raw string content at a key (creates parents as needed). */
  write(key: string, value: string): Promise<void>;
  /** Delete a key; no error if it does not exist. */
  delete(key: string): Promise<void>;
  /** True if the key exists. */
  exists(key: string): Promise<boolean>;
  /** List keys under a prefix (non-recursive directory-style listing). */
  list(prefix: string): Promise<string[]>;
  /** Read and JSON.parse, or null if absent. */
  readJson<T>(key: string): Promise<T | null>;
  /** JSON.stringify (pretty) and write. */
  writeJson(key: string, value: unknown): Promise<void>;
  /** Return a Storage scoped under the given prefix. */
  scope(prefix: string): Storage;
}
