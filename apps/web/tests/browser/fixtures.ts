import type { Page, Route } from '@playwright/test';

export const appOrigin = 'http://127.0.0.1:3107';
export const apiOrigin = 'http://127.0.0.1:3108';

const sessionKey = 'awoof.session.v1';
const fixtureWaitTimeoutMs = 5_000;
let seedNumber = 0;

export type TestRole = 'student' | 'vendor' | 'admin';

type TestUser = {
  id: string;
  email: string;
  role: TestRole;
  verificationStatus?: 'unverified' | 'verified' | 'expired';
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type Lifecycle = {
  started: Promise<void>;
  completed: Promise<void>;
  start: () => void;
  complete: () => void;
};

export type Gate = {
  wait: () => Promise<void>;
  release: () => void;
  waitForArrival: () => Promise<void>;
};

export type ApiFixtureOptions = {
  meGate?: Gate;
  delayCurrentUserCalls?: number;
  delayCurrentUserOrdinals?: readonly number[];
  loginGate?: Gate;
  refreshGate?: Gate;
  failCurrentUser?: boolean;
  unauthorizedCurrentUserCalls?: number;
};

export type BrowserApiRequest = {
  endpoint: string;
  ordinal: number;
  method: string;
  responseIdentity: string;
};

export type ApiFixture = {
  refreshCalls: number;
  meCalls: number;
  loginCalls: number;
  logoutCalls: number;
  requests: BrowserApiRequest[];
  unexpectedRequests: string[];
  waitForCurrentUserStarted: (ordinal: number) => Promise<void>;
  waitForCurrentUserCompleted: (ordinal: number) => Promise<void>;
  waitForLoginStarted: (ordinal: number) => Promise<void>;
  waitForLoginCompleted: (ordinal: number) => Promise<void>;
  waitForRefreshStarted: (ordinal: number) => Promise<void>;
  waitForRefreshCompleted: (ordinal: number) => Promise<void>;
  waitForVendorRegistrationCompleted: () => Promise<void>;
  waitForVendorUploadCompleted: () => Promise<void>;
  assertNoUnexpectedRequests: () => void;
};

type SessionWriteControlWindow = Window & {
  __awoofSessionWriteControl?: { setDenied: (denied: boolean) => void };
};

const users: Record<TestRole, TestUser> = {
  student: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'student@approved.test',
    role: 'student',
    verificationStatus: 'verified',
  },
  vendor: {
    id: '00000000-0000-4000-8000-000000000002',
    email: 'vendor@approved.test',
    role: 'vendor',
  },
  admin: {
    id: '00000000-0000-4000-8000-000000000003',
    email: 'admin@approved.test',
    role: 'admin',
  },
};

function tokensFor(role: TestRole) {
  return { accessToken: `${role}-access`, refreshToken: `${role}-refresh` };
}

function envelopeFor(
  role: TestRole,
  sessionId = `synthetic-${role}-session`,
  tokenOverrides: Partial<ReturnType<typeof tokensFor>> = {},
) {
  return {
    v: 1 as const,
    state: 'active' as const,
    sessionId,
    ...tokensFor(role),
    ...tokenOverrides,
  };
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function lifecycle(): Lifecycle {
  const started = deferred();
  const completed = deferred();
  return {
    started: started.promise,
    completed: completed.promise,
    start: started.resolve,
    complete: completed.resolve,
  };
}

async function waitFor(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), fixtureWaitTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createGate(label = 'a synthetic route gate'): Gate {
  const arrived = deferred();
  const released = deferred();
  return {
    async wait(): Promise<void> {
      arrived.resolve();
      await waitFor(released.promise, label);
    },
    release(): void {
      released.resolve();
    },
    async waitForArrival(): Promise<void> {
      await waitFor(arrived.promise, `${label} arrival`);
    },
  };
}

function body(route: Route): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(route.request().postData() ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function respond(route: Route, status: number, payload: unknown): Promise<void> {
  await route.fulfill({
    status,
    json: payload,
    headers: { 'access-control-allow-origin': appOrigin },
  });
}

function roleFromAuthorization(route: Route): TestRole | null {
  const authorization = route.request().headers().authorization;
  if (authorization === 'Bearer student-access') return 'student';
  if (authorization === 'Bearer vendor-access') return 'vendor';
  if (authorization === 'Bearer admin-access') return 'admin';
  return null;
}

function roleFromRefreshToken(route: Route): TestRole {
  const refreshToken = body(route).refreshToken;
  if (refreshToken === 'vendor-refresh') return 'vendor';
  if (refreshToken === 'admin-refresh') return 'admin';
  return 'student';
}

function shouldDelayCurrentUser(options: ApiFixtureOptions, ordinal: number): boolean {
  if (!options.meGate) return false;
  if (options.delayCurrentUserOrdinals) return options.delayCurrentUserOrdinals.includes(ordinal);
  return options.delayCurrentUserCalls === undefined || ordinal <= options.delayCurrentUserCalls;
}

function endpointLifecycle(map: Map<number, Lifecycle>, ordinal: number): Lifecycle {
  const existing = map.get(ordinal);
  if (existing) return existing;
  const next = lifecycle();
  map.set(ordinal, next);
  return next;
}

export async function installSyntheticApi(page: Page, options: ApiFixtureOptions = {}): Promise<ApiFixture> {
  const currentUserLifecycles = new Map<number, Lifecycle>();
  const loginLifecycles = new Map<number, Lifecycle>();
  const refreshLifecycles = new Map<number, Lifecycle>();
  const vendorRegistration = lifecycle();
  const vendorUpload = lifecycle();
  const fixture: ApiFixture = {
    refreshCalls: 0,
    meCalls: 0,
    loginCalls: 0,
    logoutCalls: 0,
    requests: [],
    unexpectedRequests: [],
    waitForCurrentUserStarted: (ordinal) => waitFor(endpointLifecycle(currentUserLifecycles, ordinal).started, `current-user request ${ordinal}`),
    waitForCurrentUserCompleted: (ordinal) => waitFor(endpointLifecycle(currentUserLifecycles, ordinal).completed, `current-user completion ${ordinal}`),
    waitForLoginStarted: (ordinal) => waitFor(endpointLifecycle(loginLifecycles, ordinal).started, `login request ${ordinal}`),
    waitForLoginCompleted: (ordinal) => waitFor(endpointLifecycle(loginLifecycles, ordinal).completed, `login completion ${ordinal}`),
    waitForRefreshStarted: (ordinal) => waitFor(endpointLifecycle(refreshLifecycles, ordinal).started, `refresh request ${ordinal}`),
    waitForRefreshCompleted: (ordinal) => waitFor(endpointLifecycle(refreshLifecycles, ordinal).completed, `refresh completion ${ordinal}`),
    waitForVendorRegistrationCompleted: () => waitFor(vendorRegistration.completed, 'vendor complete-registration completion'),
    waitForVendorUploadCompleted: () => waitFor(vendorUpload.completed, 'vendor upload completion'),
    assertNoUnexpectedRequests: () => {
      if (fixture.unexpectedRequests.length > 0) {
        throw new Error(`Unexpected API requests: ${fixture.unexpectedRequests.join(', ')}`);
      }
    },
  };

  function record(endpoint: string, ordinal: number, route: Route, responseIdentity: string): void {
    fixture.requests.push({ endpoint, ordinal, method: route.request().method(), responseIdentity });
  }

  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === appOrigin) return route.continue();
    if (url.origin !== apiOrigin) {
      fixture.unexpectedRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort('failed');
    }

    const method = route.request().method();
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/auth/login' && method === 'POST') {
      const ordinal = ++fixture.loginCalls;
      const request = body(route);
      const role = request.role;
      const responseIdentity = role === 'student' || role === 'vendor' || role === 'admin' ? role : 'invalid-role';
      const requestLifecycle = endpointLifecycle(loginLifecycles, ordinal);
      record('login', ordinal, route, responseIdentity);
      requestLifecycle.start();
      try {
        if (options.loginGate) await options.loginGate.wait();
        if (request.email === 'invalid@approved.test') {
          await respond(route, 401, { success: false, error: { message: 'Invalid credentials' } });
          return;
        }
        if (role !== 'student' && role !== 'vendor' && role !== 'admin') {
          await respond(route, 400, { success: false, error: { message: 'Role is required' } });
          return;
        }
        await respond(route, 200, { success: true, data: { user: users[role], tokens: tokensFor(role) } });
        return;
      } finally {
        requestLifecycle.complete();
      }
    }

    if (path === '/auth/register' && method === 'POST') {
      const request = body(route);
      const role = request.role === 'vendor' ? 'vendor' : 'student';
      record('register', 1, route, role);
      await respond(route, 201, {
        success: true,
        data: {
          user: users[role],
          tokens: tokensFor(role),
          ...(role === 'vendor' ? { requiresEmailVerification: true } : {}),
        },
      });
      return;
    }

    if (path === '/auth/me' && method === 'GET') {
      const ordinal = ++fixture.meCalls;
      const role = roleFromAuthorization(route);
      const shouldFail = options.failCurrentUser
        || (options.unauthorizedCurrentUserCalls !== undefined && ordinal <= options.unauthorizedCurrentUserCalls);
      const status = options.failCurrentUser ? 503 : 401;
      const responseIdentity = shouldFail ? `error-${status}` : role ?? 'unauthorized';
      const requestLifecycle = endpointLifecycle(currentUserLifecycles, ordinal);
      record('current-user', ordinal, route, responseIdentity);
      requestLifecycle.start();
      try {
        if (shouldDelayCurrentUser(options, ordinal)) await options.meGate?.wait();
        if (shouldFail) {
          await respond(route, status, { success: false, error: { message: 'Synthetic current-user failure' } });
          return;
        }
        if (!role) {
          await respond(route, 401, { success: false, error: { message: 'Unauthorized' } });
          return;
        }
        await respond(route, 200, { success: true, data: users[role] });
        return;
      } finally {
        requestLifecycle.complete();
      }
    }

    if (path === '/auth/refresh' && method === 'POST') {
      const ordinal = ++fixture.refreshCalls;
      const role = roleFromRefreshToken(route);
      const requestLifecycle = endpointLifecycle(refreshLifecycles, ordinal);
      record('refresh', ordinal, route, role);
      requestLifecycle.start();
      try {
        if (options.refreshGate) await options.refreshGate.wait();
        await respond(route, 200, { success: true, data: { accessToken: tokensFor(role).accessToken } });
        return;
      } finally {
        requestLifecycle.complete();
      }
    }

    if (path === '/auth/logout' && method === 'POST') {
      const ordinal = ++fixture.logoutCalls;
      record('logout', ordinal, route, 'signed-out');
      await respond(route, 200, { success: true, data: {} });
      return;
    }

    if (path === '/vendors/complete-registration' && method === 'POST') {
      record('vendor-complete-registration', 1, route, 'vendor');
      vendorRegistration.start();
      try {
        await respond(route, 200, { success: true, data: { profile: {} } });
        return;
      } finally {
        vendorRegistration.complete();
      }
    }

    if (path === '/vendors/upload' && method === 'POST') {
      record('vendor-upload', 1, route, 'vendor');
      vendorUpload.start();
      try {
        await respond(route, 200, { success: true, data: { uploaded: true } });
        return;
      } finally {
        vendorUpload.complete();
      }
    }

    if (path === '/support/notifications/unread-count' && method === 'GET') {
      record('student-unread-count', 1, route, 'student');
      await respond(route, 200, { success: true, data: { unreadCount: 0 } });
      return;
    }

    if (path === '/products' && method === 'GET') {
      record('products', 1, route, 'marketplace');
      await respond(route, 200, { success: true, data: { products: [] } });
      return;
    }

    if (path === '/products/categories' && method === 'GET') {
      record('product-categories', 1, route, 'marketplace');
      await respond(route, 200, { success: true, data: [] });
      return;
    }

    if (path === '/students/savings' && method === 'GET') {
      record('student-savings', 1, route, 'student');
      await respond(route, 200, { success: true, data: { summary: { totalSavings: 0, totalPurchases: 0 } } });
      return;
    }

    if (path === '/vendors/analytics' && method === 'GET') {
      record('vendor-analytics', 1, route, 'vendor');
      await respond(route, 200, { success: true, data: { overall: { completedOrders: 0 }, timeBased: [], topProducts: [] } });
      return;
    }

    if (path === '/vendors/orders' && method === 'GET') {
      record('vendor-orders', 1, route, 'vendor');
      await respond(route, 200, { success: true, data: { orders: [] } });
      return;
    }

    if (path === '/admin/analytics' && method === 'GET') {
      record('admin-analytics', 1, route, 'admin');
      await respond(route, 200, {
        success: true,
        data: {
          counts: {},
          transactions: {},
          vendorsByStatus: {},
          support: {},
          last30Days: {},
        },
      });
      return;
    }

    fixture.unexpectedRequests.push(`${method} ${path}`);
    return route.abort('failed');
  });
  return fixture;
}

async function seedOnce(page: Page, storageEntries: Record<string, string>): Promise<void> {
  const fixtureSeedKey = `__awoof_browser_seed_${++seedNumber}`;
  await page.addInitScript(({ fixtureSeedKey: key, entries }) => {
    // This fixture-owned sentinel is independent of application session
    // storage. It writes only on the first document in this page's session.
    if (sessionStorage.getItem(key) !== null) return;
    for (const [storageKey, value] of Object.entries(entries)) {
      localStorage.setItem(storageKey, value);
    }
    sessionStorage.setItem(key, 'seeded');
  }, { fixtureSeedKey, entries: storageEntries });
}

export async function seedSession(
  page: Page,
  role: TestRole,
  tokenOverrides: Partial<ReturnType<typeof tokensFor>> = {},
): Promise<void> {
  await seedOnce(page, { [sessionKey]: JSON.stringify(envelopeFor(role, undefined, tokenOverrides)) });
}

export async function seedLegacySession(page: Page, role: TestRole): Promise<void> {
  const tokens = tokensFor(role);
  await seedOnce(page, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
}

export async function replaceSession(page: Page, role: TestRole, sessionId?: string): Promise<void> {
  await page.evaluate((session) => {
    localStorage.setItem('awoof.session.v1', JSON.stringify(session));
  }, envelopeFor(role, sessionId));
}

export async function installSessionWriteControl(page: Page): Promise<void> {
  await page.addInitScript((targetKey) => {
    const controlledWindow = window as SessionWriteControlWindow;
    const original = Storage.prototype.setItem;
    let denied = false;
    Storage.prototype.setItem = function controlledSessionWrite(storageKey: string, value: string): void {
      if (denied && storageKey === targetKey) throw new DOMException('Denied', 'SecurityError');
      original.call(this, storageKey, value);
    };
    controlledWindow.__awoofSessionWriteControl = { setDenied(next: boolean): void { denied = next; } };
  }, sessionKey);
}

export async function setSessionWriteDenied(page: Page, denied: boolean): Promise<void> {
  await page.evaluate((next) => {
    const controlledWindow = window as SessionWriteControlWindow;
    if (!controlledWindow.__awoofSessionWriteControl) throw new Error('Synthetic session-write control was not installed.');
    controlledWindow.__awoofSessionWriteControl.setDenied(next);
  }, denied);
}

export async function writeSignedOutMarker(page: Page): Promise<void> {
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ v: 1, state: 'signed_out' }));
  }, sessionKey);
}
