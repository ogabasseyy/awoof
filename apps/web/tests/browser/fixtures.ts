import type { Page, Route } from '@playwright/test';

export const appOrigin = 'http://127.0.0.1:3107';
export const apiOrigin = 'http://127.0.0.1:3108';

export type TestRole = 'student' | 'vendor' | 'admin';

type TestUser = {
  id: string;
  email: string;
  role: TestRole;
  verificationStatus?: 'unverified' | 'verified' | 'expired';
};

type DeferredGate = {
  promise: Promise<void>;
  release: () => void;
};

export type ApiFixtureOptions = {
  meGate?: DeferredGate;
  delayCurrentUserCalls?: number;
  loginGate?: DeferredGate;
  refreshGate?: DeferredGate;
  failCurrentUser?: boolean;
  unauthorizedCurrentUserCalls?: number;
};

export type ApiFixture = {
  refreshCalls: number;
  meCalls: number;
  loginCalls: number;
  logoutCalls: number;
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

function envelopeFor(role: TestRole, sessionId = `synthetic-${role}-session`) {
  return {
    v: 1 as const,
    state: 'active' as const,
    sessionId,
    ...tokensFor(role),
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

export function createGate(): DeferredGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export async function installSyntheticApi(page: Page, options: ApiFixtureOptions = {}): Promise<ApiFixture> {
  const fixture: ApiFixture = { refreshCalls: 0, meCalls: 0, loginCalls: 0, logoutCalls: 0 };
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === appOrigin) return route.continue();
    if (url.origin !== apiOrigin) return route.abort();

    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/auth/login' && route.request().method() === 'POST') {
      fixture.loginCalls += 1;
      if (options.loginGate) await options.loginGate.promise;
      const request = body(route);
      if (request.email === 'invalid@approved.test') {
        return respond(route, 401, { success: false, error: { message: 'Invalid credentials' } });
      }
      const role = request.role;
      if (role !== 'student' && role !== 'vendor' && role !== 'admin') {
        return respond(route, 400, { success: false, error: { message: 'Role is required' } });
      }
      return respond(route, 200, { success: true, data: { user: users[role], tokens: tokensFor(role) } });
    }

    if (path === '/auth/register' && route.request().method() === 'POST') {
      const request = body(route);
      const role = request.role === 'vendor' ? 'vendor' : 'student';
      return respond(route, 201, {
        success: true,
        data: {
          user: users[role],
          tokens: tokensFor(role),
          ...(role === 'vendor' ? { requiresEmailVerification: true } : {}),
        },
      });
    }

    if (path === '/auth/me' && route.request().method() === 'GET') {
      fixture.meCalls += 1;
      const shouldDelay = options.meGate
        && (options.delayCurrentUserCalls === undefined || fixture.meCalls <= options.delayCurrentUserCalls);
      if (shouldDelay) await options.meGate.promise;
      if (
        options.failCurrentUser
        || (options.unauthorizedCurrentUserCalls !== undefined
          && fixture.meCalls <= options.unauthorizedCurrentUserCalls)
      ) {
        const status = options.failCurrentUser ? 503 : 401;
        return respond(route, status, { success: false, error: { message: 'Synthetic current-user failure' } });
      }
      const role = roleFromAuthorization(route);
      if (!role) return respond(route, 401, { success: false, error: { message: 'Unauthorized' } });
      return respond(route, 200, { success: true, data: users[role] });
    }

    if (path === '/auth/refresh' && route.request().method() === 'POST') {
      fixture.refreshCalls += 1;
      if (options.refreshGate) await options.refreshGate.promise;
      return respond(route, 200, { success: true, data: { accessToken: 'student-access' } });
    }

    if (path === '/auth/logout' && route.request().method() === 'POST') {
      fixture.logoutCalls += 1;
      return respond(route, 200, { success: true, data: {} });
    }

    return respond(route, 200, { success: true, data: {} });
  });
  return fixture;
}

export async function seedSession(page: Page, role: TestRole): Promise<void> {
  await page.addInitScript((session) => {
    localStorage.setItem('awoof.session.v1', JSON.stringify(session));
  }, envelopeFor(role));
}

export async function replaceSession(page: Page, role: TestRole, sessionId?: string): Promise<void> {
  await page.evaluate((session) => {
    localStorage.setItem('awoof.session.v1', JSON.stringify(session));
  }, envelopeFor(role, sessionId));
}

export async function writeSignedOutMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('awoof.session.v1', JSON.stringify({ v: 1, state: 'signed_out' }));
  });
}
