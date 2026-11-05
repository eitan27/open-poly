// The slice of Cloudflare KV the Drive broker and the mock Drive use, so both
// can run against an in-memory map in tests. A real `KVNamespace` binding
// satisfies this interface structurally.

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** In-memory KV for tests. TTLs are ignored — tests never run long enough. */
export function memoryKV(): KVLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix }) {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

/** Every key under `prefix`, following KV's pagination. */
export async function listAll(kv: KVLike, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    out.push(...page.keys.map((k) => k.name));
    if (page.list_complete || !page.cursor) return out;
    cursor = page.cursor;
  }
}
