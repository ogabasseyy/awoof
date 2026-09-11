import assert from 'node:assert/strict';
import { test } from 'node:test';
import axios from 'axios';
import apiClient, { publicApiClient } from '../../src/lib/api-client';
import { clearTokens, getAccessToken, isSessionStorageQuarantined, storeTokens } from '../../src/lib/auth';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitForDispatch(signal: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 250);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
}

async function withStorage(
  storage: Storage,
  run: (navigation: string[]) => Promise<void>,
  pathname = '/marketplace',
): Promise<void> {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const navigation: string[] = [];
  const location = {
    pathname,
    get href() { return navigation.at(-1) ?? '/marketplace'; },
    set href(value: string) { navigation.push(value); },
    assign(value: string) { navigation.push(value); },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      location,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    await run(navigation);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('a late old-session refresh cannot overwrite a replacement session', async () => {
  await withStorage(createStorage(), async () => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const gate = deferred<{ data: { success: true; data: { accessToken: string } }; status: number; statusText: string; headers: object; config: object }>();
    const oldApiAdapter = apiClient.defaults.adapter;
    const oldAxiosAdapter = axios.defaults.adapter;
    const refreshStarted = deferred<void>();
    let refreshCalls = 0;
    let protectedCalls = 0;
    let pending: Promise<void | undefined> | undefined;
    try {
      apiClient.defaults.adapter = async (config) => {
        protectedCalls += 1;
        return Promise.reject({ config, response: { status: 401 } });
      };
      axios.defaults.adapter = async () => {
        refreshCalls += 1;
        refreshStarted.resolve(undefined);
        return gate.promise as never;
      };

      pending = apiClient.get('/protected').then(() => undefined, () => undefined);
      await waitForDispatch(refreshStarted.promise, 'the original refresh');

      storeTokens({ accessToken: 'access-b', refreshToken: 'refresh-b' });
      gate.resolve({
        data: { success: true, data: { accessToken: 'access-a-rotated' } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      });
      await pending;

      assert.equal(getAccessToken(), 'access-b');
      assert.equal(refreshCalls, 1);
      assert.equal(protectedCalls, 1);
    } finally {
      gate.resolve(ok({}, { success: true, data: { accessToken: 'cleanup-access' } }));
      await pending;
      apiClient.defaults.adapter = oldApiAdapter;
      axios.defaults.adapter = oldAxiosAdapter;
    }
  });
});

function ok(config: object, data: unknown) {
  return { data, status: 200, statusText: 'OK', headers: {}, config } as never;
}

test('parallel expired requests share one refresh and replay with its rotated access token', async () => {
  await withStorage(createStorage(), async () => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const gate = deferred<{ data: { success: true; data: { accessToken: string } }; status: number; statusText: string; headers: object; config: object }>();
    const oldApiAdapter = apiClient.defaults.adapter;
    const oldAxiosAdapter = axios.defaults.adapter;
    const headers: string[] = [];
    let refreshCalls = 0;
    const refreshStarted = deferred<void>();
    let settled: Promise<unknown[]> | undefined;
    try {
      apiClient.defaults.adapter = async (config) => {
        const authorization = String(config.headers?.Authorization ?? '');
        headers.push(authorization);
        if (authorization === 'Bearer access-a') return Promise.reject({ config, response: { status: 401 } });
        return ok(config, { ok: true });
      };
      axios.defaults.adapter = async () => {
        refreshCalls += 1;
        refreshStarted.resolve(undefined);
        return gate.promise as never;
      };

      const first = apiClient.get('/parallel-one');
      const second = apiClient.get('/parallel-two');
      settled = Promise.all([first.catch(() => undefined), second.catch(() => undefined)]);
      await waitForDispatch(refreshStarted.promise, 'the shared refresh');
      gate.resolve({
        data: { success: true, data: { accessToken: 'access-a2' } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      });
      await Promise.all([first, second]);

      assert.equal(refreshCalls, 1);
      assert.deepEqual(headers.sort(), [
        'Bearer access-a',
        'Bearer access-a',
        'Bearer access-a2',
        'Bearer access-a2',
      ].sort());
      assert.equal(getAccessToken(), 'access-a2');
    } finally {
      gate.resolve(ok({}, { success: true, data: { accessToken: 'cleanup-access' } }));
      await settled;
      apiClient.defaults.adapter = oldApiAdapter;
      axios.defaults.adapter = oldAxiosAdapter;
      clearTokens();
    }
  });
});

test('a delayed original 401 replays with a current same-session token without a second refresh', async () => {
  await withStorage(createStorage(), async () => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const refreshGate = deferred<{ data: { success: true; data: { accessToken: string } }; status: number; statusText: string; headers: object; config: object }>();
    let rejectDelayed!: (reason: unknown) => void;
    let delayedConfig: object | undefined;
    const delayed401 = new Promise<never>((_resolve, reject) => { rejectDelayed = reject; });
    const oldApiAdapter = apiClient.defaults.adapter;
    const oldAxiosAdapter = axios.defaults.adapter;
    const delayedHeaders: string[] = [];
    let refreshCalls = 0;
    const refreshStarted = deferred<void>();
    let settled: Promise<unknown[]> | undefined;
    try {
      apiClient.defaults.adapter = async (config) => {
        const authorization = String(config.headers?.Authorization ?? '');
        if (config.url === '/first' && authorization === 'Bearer access-a') {
          return Promise.reject({ config, response: { status: 401 } });
        }
        if (config.url === '/second' && authorization === 'Bearer access-a') {
          delayedConfig = config;
          return delayed401;
        }
        if (config.url === '/second') delayedHeaders.push(authorization);
        return ok(config, { ok: true });
      };
      axios.defaults.adapter = async () => {
        refreshCalls += 1;
        refreshStarted.resolve(undefined);
        return refreshGate.promise as never;
      };

      const first = apiClient.get('/first');
      const second = apiClient.get('/second');
      settled = Promise.all([first.catch(() => undefined), second.catch(() => undefined)]);
      await waitForDispatch(refreshStarted.promise, 'the first refresh');
      refreshGate.resolve({
        data: { success: true, data: { accessToken: 'access-a2' } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      });
      await first;
      rejectDelayed({ config: delayedConfig, response: { status: 401 } });
      await second;

      assert.equal(refreshCalls, 1);
      assert.deepEqual(delayedHeaders, ['Bearer access-a2']);
    } finally {
      refreshGate.resolve(ok({}, { success: true, data: { accessToken: 'cleanup-access' } }));
      if (rejectDelayed) rejectDelayed(new Error('test cleanup'));
      await settled;
      apiClient.defaults.adapter = oldApiAdapter;
      axios.defaults.adapter = oldAxiosAdapter;
      clearTokens();
    }
  });
});

test('a public 401 never refreshes or clears the browser session', async () => {
  await withStorage(createStorage(), async () => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const oldPublicAdapter = publicApiClient.defaults.adapter;
    const oldAxiosAdapter = axios.defaults.adapter;
    let refreshCalls = 0;
    try {
      publicApiClient.defaults.adapter = async (config) => Promise.reject({ config, response: { status: 401 } });
      axios.defaults.adapter = async () => {
        refreshCalls += 1;
        return ok({}, { success: true, data: { accessToken: 'not-used' } });
      };

      await publicApiClient.get('/public-otp').catch(() => undefined);

      assert.equal(refreshCalls, 0);
      assert.equal(getAccessToken(), 'access-a');
    } finally {
      publicApiClient.defaults.adapter = oldPublicAdapter;
      axios.defaults.adapter = oldAxiosAdapter;
      clearTokens();
    }
  });
});

test('a terminal 401 keeps a failed signed-out marker quarantine in the current document', async () => {
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
  await withStorage(storage, async (navigation) => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const oldApiAdapter = apiClient.defaults.adapter;
    const oldAxiosAdapter = axios.defaults.adapter;
    try {
      apiClient.defaults.adapter = async (config) => {
        const authorization = String(config.headers?.Authorization ?? '');
        if (authorization === 'Bearer access-a') return Promise.reject({ config, response: { status: 401 } });
        denyWrites = true;
        return Promise.reject({ config, response: { status: 401 } });
      };
      axios.defaults.adapter = async (config) => ok(config, {
        success: true,
        data: { accessToken: 'access-a2' },
      });

      await apiClient.get('/terminal-401').catch(() => undefined);

      assert.equal(isSessionStorageQuarantined(), true);
      assert.equal(getAccessToken(), null);
      assert.deepEqual(navigation, []);
    } finally {
      denyWrites = false;
      apiClient.defaults.adapter = oldApiAdapter;
      axios.defaults.adapter = oldAxiosAdapter;
      clearTokens();
    }
  });
});

test('a successful terminal 401 on an auth path persists signed-out without navigation', async () => {
  const storage = createStorage();
  await withStorage(storage, async (navigation) => {
    storeTokens({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    const oldApiAdapter = apiClient.defaults.adapter;
    const oldAxiosAdapter = axios.defaults.adapter;
    try {
      apiClient.defaults.adapter = async (config) => Promise.reject({ config, response: { status: 401 } });
      axios.defaults.adapter = async (config) => ok(config, {
        success: true,
        data: { accessToken: 'access-a2' },
      });

      await apiClient.get('/terminal-401-on-auth').catch(() => undefined);

      assert.equal(isSessionStorageQuarantined(), false);
      assert.equal(getAccessToken(), null);
      assert.match(storage.getItem('awoof.session.v1') ?? '', /"state":"signed_out"/);
      assert.deepEqual(navigation, []);
    } finally {
      apiClient.defaults.adapter = oldApiAdapter;
      axios.defaults.adapter = oldAxiosAdapter;
      clearTokens();
    }
  }, '/auth/student/login');
});
