import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  getSessionSnapshot,
  isCurrentSession,
  isExactSession,
  isSessionStorageQuarantined,
  replaceCurrentSessionTokens,
  storeTokens,
  subscribeSessionChanges,
} from '../../src/lib/auth';

function withStorage(storage: Storage, run: () => void): void {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    run();
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('blocked reads return no usable session', () => {
  withStorage({
    length: 0,
    clear() {},
    key() { return null; },
    setItem() {},
    removeItem() {},
    getItem() { throw new Error('SecurityError'); },
  }, () => {
    assert.equal(getAccessToken(), null);
    assert.equal(getRefreshToken(), null);
  });
});

test('failed token persistence is a stable failure and leaves no usable session', () => {
  withStorage({
    length: 0,
    clear() {},
    key() { return null; },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('Removal denied'); },
    getItem() { return null; },
  }, () => {
    assert.throws(
      () => storeTokens({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
      /Session storage is unavailable/,
    );
    assert.equal(getAccessToken(), null);
    assert.equal(getRefreshToken(), null);
  });
});

function memoryStorage(initial: Record<string, string> = {}, removeDenied = false): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) {
      if (removeDenied) throw new Error('Removal denied');
      values.delete(key);
    },
    setItem(key, value) { values.set(key, value); },
  };
}

function resetSessionState(): void {
  withStorage(memoryStorage(), () => clearTokens());
}

test('migrates only a complete legacy pair and the signed-out marker prevents its resurrection', () => {
  resetSessionState();
  const storage = memoryStorage({ accessToken: 'legacy-access', refreshToken: 'legacy-refresh' }, true);
  withStorage(storage, () => {
    assert.equal(getAccessToken(), 'legacy-access');
    assert.match(storage.getItem('awoof.session.v1') ?? '', /"state":"active"/);

    clearTokens();

    assert.equal(getAccessToken(), null);
    assert.equal(storage.getItem('accessToken'), 'legacy-access');
    assert.match(storage.getItem('awoof.session.v1') ?? '', /"state":"signed_out"/);
  });
});

test('a malformed envelope is authoritative signed-out state even beside complete legacy keys', () => {
  resetSessionState();
  const storage = memoryStorage({
    'awoof.session.v1': '{not-json',
    accessToken: 'legacy-access',
    refreshToken: 'legacy-refresh',
  });
  withStorage(storage, () => {
    assert.equal(getAccessToken(), null);
    assert.equal(getRefreshToken(), null);
  });
});

test('a blocked logout quarantines the tab until an explicit durable clear succeeds', () => {
  resetSessionState();
  const values = new Map<string, string>();
  let denyWrites = false;
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) {
      if (denyWrites) throw new Error('Removal denied');
      values.delete(key);
    },
    setItem(key, value) {
      if (denyWrites) throw new Error('Quota denied');
      values.set(key, value);
    },
  };
  withStorage(storage, () => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    denyWrites = true;
    clearTokens();
    denyWrites = false;

    assert.equal(getAccessToken(), null);
    clearTokens();
    assert.equal(getAccessToken(), null);
    assert.match(storage.getItem('awoof.session.v1') ?? '', /"state":"signed_out"/);
  });
});

test('a live subscriber receives the final durable-clear state after a failed clear recovers', () => {
  resetSessionState();
  const values = new Map<string, string>();
  let denyWrites = false;
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) {
      if (denyWrites) throw new Error('Removal denied');
      values.delete(key);
    },
    setItem(key, value) {
      if (denyWrites) throw new Error('Quota denied');
      values.set(key, value);
    },
  };
  withStorage(storage, () => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const states: Array<{ accessToken: string | null; quarantined: boolean }> = [];
    const unsubscribe = subscribeSessionChanges(() => {
      states.push({
        accessToken: getAccessToken(),
        quarantined: isSessionStorageQuarantined(),
      });
    });
    try {
      denyWrites = true;
      clearTokens();
      denyWrites = false;
      clearTokens();

      assert.deepEqual(states, [
        { accessToken: null, quarantined: true },
        { accessToken: null, quarantined: false },
      ]);
      assert.match(storage.getItem('awoof.session.v1') ?? '', /"state":"signed_out"/);
    } finally {
      unsubscribe();
    }
  });
});

test('an own refresh keeps a logical session current while fencing its old exact pair', () => {
  resetSessionState();
  withStorage(memoryStorage(), () => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const beforeRefresh = getSessionSnapshot();

    assert.equal(
      replaceCurrentSessionTokens(beforeRefresh, { accessToken: 'access-a2', refreshToken: 'refresh-a' }),
      true,
    );
    assert.equal(isCurrentSession(beforeRefresh), true);
    assert.equal(isExactSession(beforeRefresh), false);
    assert.equal(getAccessToken(), 'access-a2');
  });
});

test('subscribers see local login plus provisional and durable logout lifecycle changes', () => {
  resetSessionState();
  withStorage(memoryStorage(), () => {
    let changes = 0;
    const unsubscribe = subscribeSessionChanges(() => { changes += 1; });
    try {
      storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
      clearTokens();
      assert.equal(changes, 3);
    } finally {
      unsubscribe();
    }
  });
});
