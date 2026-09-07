import type { Page, Route } from '@playwright/test';

export const appOrigin = 'http://127.0.0.1:3107';
export const apiOrigin = 'http://127.0.0.1:3108';
export const storageTabPath = '/__awoof-browser-storage-tab__';

const sessionKey = 'awoof.session.v1';
const fixtureWaitTimeoutMs = 5_000;
const xhrRefreshContinuationPrefix = '[awoof-fixture/xhr-refresh-continuation]:';
let seedNumber = 0;

export type TestRole = 'student' | 'vendor' | 'admin';
type TestSessionRole = TestRole | 'vendorB';

type TestUser = {
  id: string;
  email: string;
  role: TestRole;
  verificationStatus?: 'unverified' | 'verified' | 'expired';
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type Lifecycle = {
  started: Promise<void>;
  completed: Promise<void>;
  continued: Promise<void>;
  start: () => void;
  complete: () => void;
  continue: () => void;
  fail: (error: unknown) => void;
  failContinuation: (error: unknown) => void;
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
  currentUserGates?: Readonly<Record<number, Gate>>;
  loginGate?: Gate;
  registerGate?: Gate;
  refreshGate?: Gate;
  failCurrentUser?: boolean;
  failCurrentUserOrdinals?: readonly number[];
  unauthorizedCurrentUserCalls?: number;
  unauthorizedCurrentUserOrdinals?: readonly number[];
  universityStatus?: 200 | 401 | 503;
  universityResults?: readonly unknown[];
};

export type FixtureUniversity = {
  id: string;
  name: string;
  shortcode: string;
  domain: string;
  country: string;
};

export const fixtureUniversities: readonly FixtureUniversity[] = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Approved Alpha University', shortcode: 'AAU', domain: 'alpha.approved.test', country: 'Nigeria' },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Approved Beta University', shortcode: 'ABU', domain: 'beta.approved.test', country: 'Ghana' },
];

export type BrowserApiRequest = {
  endpoint: string;
  ordinal: number;
  method: string;
  responseIdentity: string;
};

export type SyntheticHttpFailure = {
  path: string;
  status: number;
};

export type ApiFixture = {
  refreshCalls: number;
  meCalls: number;
  loginCalls: number;
  registerCalls: number;
  logoutCalls: number;
  universityRequests: Array<{ ordinal: number; authorizationPresent: boolean }>;
  requests: BrowserApiRequest[];
  syntheticHttpFailures: SyntheticHttpFailure[];
  unexpectedRequests: string[];
  waitForCurrentUserStarted: (ordinal: number) => Promise<void>;
  waitForCurrentUserCompleted: (ordinal: number) => Promise<void>;
  waitForLoginStarted: (ordinal: number) => Promise<void>;
  waitForLoginCompleted: (ordinal: number) => Promise<void>;
  waitForRegisterStarted: (ordinal: number) => Promise<void>;
  waitForRegisterCompleted: (ordinal: number) => Promise<void>;
  waitForRefreshStarted: (ordinal: number) => Promise<void>;
  waitForRefreshCompleted: (ordinal: number) => Promise<void>;
  waitForRefreshContinuation: (ordinal: number) => Promise<void>;
  waitForUniversitiesCompleted: (ordinal: number) => Promise<void>;
  setUniversityDirectory: (status: 200 | 401 | 503, universities?: readonly unknown[]) => void;
  waitForVendorRegistrationCompleted: () => Promise<void>;
  waitForVendorUploadCompleted: () => Promise<void>;
  drainPendingHandlers: () => Promise<void>;
  assertNoUnexpectedRequests: () => void;
};

type SessionWriteControlWindow = Window & {
  __awoofSessionWriteControl?: { setSignedOutMarkerDenied: (denied: boolean) => void };
};

const users: Record<TestSessionRole, TestUser> = {
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
  vendorB: {
    id: '00000000-0000-4000-8000-000000000004',
    email: 'vendor-b@approved.test',
    role: 'vendor',
  },
  admin: {
    id: '00000000-0000-4000-8000-000000000003',
    email: 'admin@approved.test',
    role: 'admin',
  },
};

function tokensFor(role: TestSessionRole) {
  if (role === 'vendorB') return { accessToken: 'vendor-b-access', refreshToken: 'vendor-b-refresh' };
  return { accessToken: `${role}-access`, refreshToken: `${role}-refresh` };
}

function envelopeFor(
  role: TestSessionRole,
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
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  // Every fixture lifecycle is observed by its waiter and the cleanup drain,
  // but register a rejection observer immediately so a failing route handler
  // cannot become an unhandled rejection before teardown reports it.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function lifecycle(): Lifecycle {
  const started = deferred();
  const completed = deferred();
  const continued = deferred();
  return {
    started: started.promise,
    completed: completed.promise,
    continued: continued.promise,
    start: started.resolve,
    complete: completed.resolve,
    continue: continued.resolve,
    fail(error: unknown): void {
      const failure = asError(error);
      completed.reject(failure);
      continued.reject(failure);
    },
    failContinuation(error: unknown): void {
      continued.reject(asError(error));
    },
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

function roleFromAuthorization(route: Route): TestSessionRole | null {
  const authorization = route.request().headers().authorization;
  if (authorization === 'Bearer student-access') return 'student';
  if (authorization === 'Bearer vendor-access') return 'vendor';
  if (authorization === 'Bearer vendor-b-access') return 'vendorB';
  if (authorization === 'Bearer admin-access') return 'admin';
  return null;
}

function roleFromRefreshToken(route: Route): TestSessionRole {
  const refreshToken = body(route).refreshToken;
  if (refreshToken === 'vendor-refresh') return 'vendor';
  if (refreshToken === 'vendor-b-refresh') return 'vendorB';
  if (refreshToken === 'admin-refresh') return 'admin';
  return 'student';
}

function shouldDelayCurrentUser(options: ApiFixtureOptions, ordinal: number): boolean {
  if (!options.meGate) return false;
  if (options.delayCurrentUserOrdinals) return options.delayCurrentUserOrdinals.includes(ordinal);
  return options.delayCurrentUserCalls === undefined || ordinal <= options.delayCurrentUserCalls;
}

function gateForCurrentUser(options: ApiFixtureOptions, ordinal: number): Gate | undefined {
  return options.currentUserGates?.[ordinal]
    ?? (shouldDelayCurrentUser(options, ordinal) ? options.meGate : undefined);
}

function endpointLifecycle(map: Map<number, Lifecycle>, ordinal: number): Lifecycle {
  const existing = map.get(ordinal);
  if (existing) return existing;
  const next = lifecycle();
  map.set(ordinal, next);
  return next;
}

async function installXhrRefreshContinuationObserver(page: Page): Promise<void> {
  await page.addInitScript(({ origin, prefix }) => {
    const originalSend = XMLHttpRequest.prototype.send;
    let refreshOrdinal = 0;

    XMLHttpRequest.prototype.send = function observedSend(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      // Axios assigns its native onloadend handler before calling send. This
      // listener is intentionally registered afterwards, so its signal follows
      // the adapter's response settlement. Two microtask turns plus the next
      // frame provide a bounded browser-side continuation fence without
      // modifying React, application code, or a window test global.
      this.addEventListener('loadend', () => {
        try {
          const responseUrl = new URL(this.responseURL);
          if (responseUrl.origin !== origin || responseUrl.pathname.replace(/^\/api/, '') !== '/auth/refresh') return;
          const ordinal = ++refreshOrdinal;
          queueMicrotask(() => {
            queueMicrotask(() => {
              requestAnimationFrame(() => {
                console.debug(`${prefix}${ordinal}`);
              });
            });
          });
        } catch {
          // This observer never changes application request behavior. A
          // malformed response URL simply cannot satisfy the bounded signal.
        }
      }, { once: true });
      originalSend.call(this, body);
    };
  }, { origin: apiOrigin, prefix: xhrRefreshContinuationPrefix });
}

export async function installSyntheticApi(page: Page, options: ApiFixtureOptions = {}): Promise<ApiFixture> {
  const currentUserLifecycles = new Map<number, Lifecycle>();
  const loginLifecycles = new Map<number, Lifecycle>();
  const registerLifecycles = new Map<number, Lifecycle>();
  const refreshLifecycles = new Map<number, Lifecycle>();
  const universityLifecycles = new Map<number, Lifecycle>();
  const vendorRegistration = lifecycle();
  const vendorUpload = lifecycle();
  const pendingHandlers = new Set<Promise<void>>();
  const successfulHandlers: string[] = [];
  const failedHandlers: Array<{ label: string; error: Error }> = [];
  let directoryStatus = options.universityStatus ?? 200;
  let directoryResults: readonly unknown[] = options.universityResults ?? fixtureUniversities;

  function trackHandler(label: string, handler: () => Promise<void>): Promise<void> {
    const pending = Promise.resolve().then(handler);
    pendingHandlers.add(pending);
    void pending.then(
      () => {
        successfulHandlers.push(label);
        pendingHandlers.delete(pending);
      },
      (error: unknown) => {
        failedHandlers.push({ label, error: asError(error) });
        pendingHandlers.delete(pending);
      },
    );
    return pending;
  }

  async function drainPendingHandlers(): Promise<void> {
    let drainPass = 0;
    while (pendingHandlers.size > 0) {
      if (++drainPass > 8) {
        throw new Error(`Synthetic API handler drainage did not settle after ${drainPass - 1} passes.`);
      }
      const pending = [...pendingHandlers];
      await waitFor(
        Promise.allSettled(pending).then(() => undefined),
        `synthetic API handler drainage pass ${drainPass}`,
      );
    }
    if (failedHandlers.length > 0) {
      const details = failedHandlers
        .map(({ label, error }) => `${label}: ${error.message}`)
        .join('; ');
      throw new Error(
        `Synthetic API handler failure after ${successfulHandlers.length} successful handler(s): ${details}`,
      );
    }
  }

  await installXhrRefreshContinuationObserver(page);
  page.on('console', (message) => {
    const ordinalText = message.text().slice(xhrRefreshContinuationPrefix.length);
    if (!message.text().startsWith(xhrRefreshContinuationPrefix) || !/^\d+$/.test(ordinalText)) return;
    endpointLifecycle(refreshLifecycles, Number(ordinalText)).continue();
  });

  const fixture: ApiFixture = {
    refreshCalls: 0,
    meCalls: 0,
    loginCalls: 0,
    registerCalls: 0,
    logoutCalls: 0,
    universityRequests: [],
    requests: [],
    syntheticHttpFailures: [],
    unexpectedRequests: [],
    waitForCurrentUserStarted: (ordinal) => waitFor(endpointLifecycle(currentUserLifecycles, ordinal).started, `current-user request ${ordinal}`),
    waitForCurrentUserCompleted: (ordinal) => waitFor(endpointLifecycle(currentUserLifecycles, ordinal).completed, `current-user completion ${ordinal}`),
    waitForLoginStarted: (ordinal) => waitFor(endpointLifecycle(loginLifecycles, ordinal).started, `login request ${ordinal}`),
    waitForLoginCompleted: (ordinal) => waitFor(endpointLifecycle(loginLifecycles, ordinal).completed, `login completion ${ordinal}`),
    waitForRegisterStarted: (ordinal) => waitFor(endpointLifecycle(registerLifecycles, ordinal).started, `register request ${ordinal}`),
    waitForRegisterCompleted: (ordinal) => waitFor(endpointLifecycle(registerLifecycles, ordinal).completed, `register completion ${ordinal}`),
    waitForRefreshStarted: (ordinal) => waitFor(endpointLifecycle(refreshLifecycles, ordinal).started, `refresh request ${ordinal}`),
    waitForRefreshCompleted: (ordinal) => waitFor(endpointLifecycle(refreshLifecycles, ordinal).completed, `refresh completion ${ordinal}`),
    waitForRefreshContinuation: (ordinal) => waitFor(endpointLifecycle(refreshLifecycles, ordinal).continued, `refresh browser continuation ${ordinal}`),
    waitForUniversitiesCompleted: (ordinal) => waitFor(endpointLifecycle(universityLifecycles, ordinal).completed, `universities completion ${ordinal}`),
    setUniversityDirectory: (status, universities) => {
      directoryStatus = status;
      directoryResults = universities ?? fixtureUniversities;
    },
    waitForVendorRegistrationCompleted: () => waitFor(vendorRegistration.completed, 'vendor complete-registration completion'),
    waitForVendorUploadCompleted: () => waitFor(vendorUpload.completed, 'vendor upload completion'),
    drainPendingHandlers,
    assertNoUnexpectedRequests: () => {
      if (fixture.unexpectedRequests.length > 0) {
        throw new Error(`Unexpected API requests: ${fixture.unexpectedRequests.join(', ')}`);
      }
    },
  };

  function record(endpoint: string, ordinal: number, route: Route, responseIdentity: string): void {
    fixture.requests.push({ endpoint, ordinal, method: route.request().method(), responseIdentity });
  }

  function recordSyntheticHttpFailure(path: string, status: number): void {
    fixture.syntheticHttpFailures.push({ path, status });
  }

  async function completeLifecycle(lifecycleToComplete: Lifecycle, handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
      lifecycleToComplete.complete();
    } catch (error) {
      lifecycleToComplete.fail(error);
      throw error;
    }
  }

  await page.context().route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const handlerLabel = `${request.method()} ${url.pathname}`;
    return trackHandler(handlerLabel, async () => {
    if (url.origin === appOrigin) {
      if (url.pathname === storageTabPath) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Awoof browser storage fixture</title>',
        });
        return;
      }
      return route.continue();
    }
    if (url.origin !== apiOrigin) {
      fixture.unexpectedRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort('failed');
    }

    const method = route.request().method();
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/universities' && method === 'GET') {
      const ordinal = fixture.universityRequests.length + 1;
      fixture.universityRequests.push({
        ordinal,
        authorizationPresent: route.request().headers().authorization !== undefined,
      });
      const requestLifecycle = endpointLifecycle(universityLifecycles, ordinal);
      requestLifecycle.start();
      return completeLifecycle(requestLifecycle, async () => {
        if (directoryStatus !== 200) {
          recordSyntheticHttpFailure(path, directoryStatus);
          await respond(route, directoryStatus, { success: false, error: { message: 'Synthetic university directory failure' } });
          return;
        }
        await respond(route, 200, { success: true, data: { universities: directoryResults, total: directoryResults.length } });
      });
    }

    if (path === '/auth/login' && method === 'POST') {
      const ordinal = ++fixture.loginCalls;
      const request = body(route);
      const role = request.role;
      const responseIdentity = role === 'student' || role === 'vendor' || role === 'admin' ? role : 'invalid-role';
      const requestLifecycle = endpointLifecycle(loginLifecycles, ordinal);
      record('login', ordinal, route, responseIdentity);
      requestLifecycle.start();
      return completeLifecycle(requestLifecycle, async () => {
        if (options.loginGate) await options.loginGate.wait();
        if (request.email === 'invalid@approved.test') {
          recordSyntheticHttpFailure(path, 401);
          await respond(route, 401, { success: false, error: { message: 'Invalid credentials' } });
          return;
        }
        if (role !== 'student' && role !== 'vendor' && role !== 'admin') {
          await respond(route, 400, { success: false, error: { message: 'Role is required' } });
          return;
        }
        await respond(route, 200, { success: true, data: { user: users[role], tokens: tokensFor(role) } });
      });
    }

    if (path === '/auth/register' && method === 'POST') {
      const ordinal = ++fixture.registerCalls;
      const request = body(route);
      const role = request.role === 'vendor' ? 'vendor' : 'student';
      const requestLifecycle = endpointLifecycle(registerLifecycles, ordinal);
      record('register', ordinal, route, role);
      requestLifecycle.start();
      return completeLifecycle(requestLifecycle, async () => {
        if (options.registerGate) await options.registerGate.wait();
        await respond(route, 201, {
          success: true,
          data: {
            user: users[role],
            tokens: tokensFor(role),
            ...(role === 'vendor' ? { requiresEmailVerification: true } : {}),
          },
        });
      });
    }

    if (path === '/auth/me' && method === 'GET') {
      const ordinal = ++fixture.meCalls;
      const role = roleFromAuthorization(route);
      const serviceFailure = options.failCurrentUser || options.failCurrentUserOrdinals?.includes(ordinal);
      const unauthorized = options.unauthorizedCurrentUserOrdinals?.includes(ordinal)
        ?? (options.unauthorizedCurrentUserCalls !== undefined && ordinal <= options.unauthorizedCurrentUserCalls);
      const shouldFail = serviceFailure || unauthorized;
      const status = serviceFailure ? 503 : 401;
      const responseIdentity = shouldFail ? `error-${status}` : role ?? 'unauthorized';
      const requestLifecycle = endpointLifecycle(currentUserLifecycles, ordinal);
      record('current-user', ordinal, route, responseIdentity);
      requestLifecycle.start();
      return completeLifecycle(requestLifecycle, async () => {
        await gateForCurrentUser(options, ordinal)?.wait();
        if (shouldFail) {
          recordSyntheticHttpFailure(path, status);
          await respond(route, status, { success: false, error: { message: 'Synthetic current-user failure' } });
          return;
        }
        if (!role) {
          recordSyntheticHttpFailure(path, 401);
          await respond(route, 401, { success: false, error: { message: 'Unauthorized' } });
          return;
        }
        await respond(route, 200, { success: true, data: users[role] });
      });
    }

    if (path === '/auth/refresh' && method === 'POST') {
      const ordinal = ++fixture.refreshCalls;
      const role = roleFromRefreshToken(route);
      const requestLifecycle = endpointLifecycle(refreshLifecycles, ordinal);
      record('refresh', ordinal, route, role);
      requestLifecycle.start();
      return completeLifecycle(requestLifecycle, async () => {
        if (options.refreshGate) await options.refreshGate.wait();
        await respond(route, 200, { success: true, data: { accessToken: tokensFor(role).accessToken } });
      });
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
      return completeLifecycle(vendorRegistration, async () => {
        await respond(route, 200, { success: true, data: { profile: {} } });
      });
    }

    if (path === '/vendors/upload' && method === 'POST') {
      record('vendor-upload', 1, route, 'vendor');
      vendorUpload.start();
      return completeLifecycle(vendorUpload, async () => {
        await respond(route, 200, { success: true, data: { uploaded: true } });
      });
    }

    if (path === '/support/notifications/unread-count' && method === 'GET') {
      record('student-unread-count', 1, route, 'student');
      await respond(route, 200, { success: true, data: { unreadCount: 0 } });
      return;
    }

    if (path === '/support/notifications' && method === 'GET') {
      record('notifications', 1, route, roleFromAuthorization(route) ?? 'unauthenticated');
      await respond(route, 200, { success: true, data: { notifications: [] } });
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
  role: TestSessionRole,
  tokenOverrides: Partial<ReturnType<typeof tokensFor>> = {},
): Promise<void> {
  await seedOnce(page, { [sessionKey]: JSON.stringify(envelopeFor(role, undefined, tokenOverrides)) });
}

export async function seedLegacySession(page: Page, role: TestRole): Promise<void> {
  const tokens = tokensFor(role);
  await seedOnce(page, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
}

export async function replaceSession(page: Page, role: TestSessionRole, sessionId?: string): Promise<void> {
  await page.evaluate((session) => {
    localStorage.setItem('awoof.session.v1', JSON.stringify(session));
  }, envelopeFor(role, sessionId));
}

export async function installSessionWriteControl(page: Page): Promise<void> {
  await page.addInitScript((targetKey) => {
    const controlledWindow = window as SessionWriteControlWindow;
    const original = Storage.prototype.setItem;
    let signedOutMarkerDenied = false;
    Storage.prototype.setItem = function controlledSessionWrite(storageKey: string, value: string): void {
      let signedOutMarker = false;
      try {
        const parsed: unknown = JSON.parse(value);
        signedOutMarker = !!parsed
          && typeof parsed === 'object'
          && (parsed as { v?: unknown; state?: unknown }).v === 1
          && (parsed as { state?: unknown }).state === 'signed_out';
      } catch {
        signedOutMarker = false;
      }
      if (signedOutMarkerDenied && storageKey === targetKey && signedOutMarker) {
        throw new DOMException('Denied', 'SecurityError');
      }
      original.call(this, storageKey, value);
    };
    controlledWindow.__awoofSessionWriteControl = {
      setSignedOutMarkerDenied(next: boolean): void {
        signedOutMarkerDenied = next;
      },
    };
  }, sessionKey);
}

export async function setSignedOutMarkerWriteDenied(page: Page, denied: boolean): Promise<void> {
  await page.evaluate((next) => {
    const controlledWindow = window as SessionWriteControlWindow;
    if (!controlledWindow.__awoofSessionWriteControl) throw new Error('Synthetic session-write control was not installed.');
    controlledWindow.__awoofSessionWriteControl.setSignedOutMarkerDenied(next);
  }, denied);
}

export async function writeSignedOutMarker(page: Page): Promise<void> {
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ v: 1, state: 'signed_out' }));
  }, sessionKey);
}
