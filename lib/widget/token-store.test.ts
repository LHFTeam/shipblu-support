import { afterEach, describe, expect, it } from 'vitest';
import { clearToken, readToken, writeToken } from './token-store';

/**
 * The widget in a third-party iframe with storage blocked, which is where the
 * unguarded version threw: from the `localStorage` property itself, and from
 * each method on a store that exists but refuses.
 */

function install(value: PropertyDescriptor): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...value });
}

function memoryStore(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
    key: () => null,
    get length() {
      return items.size;
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('the widget token store', () => {
  it('keeps a token across reads, and forgets it when cleared', () => {
    install({ value: memoryStore() });

    expect(readToken()).toBeNull();
    writeToken('t-1');
    expect(readToken()).toBe('t-1');
    clearToken();
    expect(readToken()).toBeNull();
  });

  it('reads as no token, and never throws, when the property itself is refused', () => {
    install({
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });

    expect(readToken()).toBeNull();
    expect(() => writeToken('t-1')).not.toThrow();
    expect(() => clearToken()).not.toThrow();
  });

  it('never throws when the store exists but every method refuses', () => {
    const refuse = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    install({
      value: { ...memoryStore(), getItem: refuse, setItem: refuse, removeItem: refuse },
    });

    expect(readToken()).toBeNull();
    expect(() => writeToken('t-1')).not.toThrow();
    expect(() => clearToken()).not.toThrow();
  });
});
