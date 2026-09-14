// A real Web Storage implementation for jsdom tests.
//
// jsdom provides a working localStorage/sessionStorage of its own — verified
// directly: `new JSDOM("", { url }).window.localStorage.setItem(...)` round-trips
// fine. What does not survive is the trip into the test's global scope: vitest
// copies the jsdom window's properties onto globalThis, and `localStorage`
// arrives as a bare `{}` with none of the Storage methods on it, so the first
// `localStorage.getItem(...)` throws "is not a function".
//
// Rather than hide that in a global setup file, a test that needs storage calls
// `installWebStorage()` and can see exactly what it is running against. Backed
// by a Map, it implements the whole Storage interface including `length`, `key`
// and index access semantics, and it throws the same way the real thing does on
// a missing argument.

class MemoryStorage implements Storage {
  #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.#items.get(String(key)) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.#items.delete(String(key));
  }
  clear(): void {
    this.#items.clear();
  }
}

/** Install fresh local/session storage on the jsdom window, and return a
 *  `restore()` that puts back whatever was there. Call it per test file (or in
 *  `beforeEach` for a clean slate between tests). */
export function installWebStorage(): { local: Storage; session: Storage; restore: () => void } {
  const previous = {
    local: Object.getOwnPropertyDescriptor(window, "localStorage"),
    session: Object.getOwnPropertyDescriptor(window, "sessionStorage"),
  };
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const define = (name: string, value: Storage) =>
    Object.defineProperty(window, name, { value, configurable: true, writable: true });
  define("localStorage", local);
  define("sessionStorage", session);
  return {
    local,
    session,
    restore() {
      if (previous.local) Object.defineProperty(window, "localStorage", previous.local);
      if (previous.session) Object.defineProperty(window, "sessionStorage", previous.session);
    },
  };
}
