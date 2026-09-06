/** Centralized HTTP clients with session-fenced authenticated retries. */

import axios from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import {
    clearTokens,
    getSessionSnapshot,
    isCurrentSession,
    isExactSession,
    replaceCurrentSessionTokens,
    type SessionSnapshot,
} from './auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export function getImageUrl(imagePath: string | null | undefined): string | null {
    if (!imagePath) return null;
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) return imagePath;
    return `${API_URL}${imagePath}`;
}

const apiClient: AxiosInstance = axios.create({
    baseURL: `${API_URL}/api`,
    headers: { 'Content-Type': 'application/json' },
});

/** Public/auth-start requests never refresh, clear, or navigate globally. */
export const publicApiClient: AxiosInstance = axios.create({
    baseURL: `${API_URL}/api`,
    headers: { 'Content-Type': 'application/json' },
});

type RequestCredentials = {
    accessToken: string | null;
    refreshToken: string | null;
};

type SessionBoundRequest = InternalAxiosRequestConfig & {
    __awoofSession?: SessionSnapshot;
    __awoofCredentials?: RequestCredentials;
    __awoofRetried?: boolean;
};

const refreshes = new Map<string, Promise<string>>();

function refreshKey(snapshot: SessionSnapshot): string | null {
    return snapshot.refreshToken ? `${snapshot.generation}:${snapshot.refreshToken}` : null;
}

function staleSessionError(): Error {
    return new Error('This request belongs to a session that is no longer active.');
}

function setAuthorization(config: SessionBoundRequest, accessToken: string | null): void {
    if (!config.headers) return;
    if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
    else delete config.headers.Authorization;
}

function applyMultipartHeader(config: InternalAxiosRequestConfig): void {
    if (config.data instanceof FormData && config.headers) {
        if (typeof config.headers.delete === 'function') config.headers.delete('Content-Type');
        else delete config.headers['Content-Type'];
    }
}

async function performRefresh(snapshotAtStart: SessionSnapshot): Promise<string> {
    if (!snapshotAtStart.refreshToken || !isExactSession(snapshotAtStart)) throw staleSessionError();
    const response = await axios.post(`${API_URL}/api/auth/refresh`, {
        refreshToken: snapshotAtStart.refreshToken,
    });
    const payload = response.data?.data ?? response.data;
    const accessToken = payload?.accessToken;
    const replacementRefreshToken = payload?.refreshToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new Error('Malformed refresh response.');
    }
    const refreshToken = typeof replacementRefreshToken === 'string' && replacementRefreshToken.length > 0
        ? replacementRefreshToken
        : snapshotAtStart.refreshToken;
    if (!isExactSession(snapshotAtStart)) throw staleSessionError();
    if (!replaceCurrentSessionTokens(snapshotAtStart, { accessToken, refreshToken })) throw staleSessionError();
    return accessToken;
}

function refreshFor(snapshotAtStart: SessionSnapshot): Promise<string> {
    const key = refreshKey(snapshotAtStart);
    if (!key) return Promise.reject(staleSessionError());
    const existing = refreshes.get(key);
    if (existing) return existing;
    const pending = performRefresh(snapshotAtStart).finally(() => {
        if (refreshes.get(key) === pending) refreshes.delete(key);
    });
    refreshes.set(key, pending);
    return pending;
}

function exactFailedRequest(request: SessionBoundRequest): SessionSnapshot | null {
    const started = request.__awoofSession;
    const credentials = request.__awoofCredentials;
    if (!started || !credentials) return null;
    return { ...started, ...credentials };
}

function clearOnlyCurrentFailedSession(request: SessionBoundRequest): void {
    const failed = exactFailedRequest(request);
    if (!failed || !isExactSession(failed)) return;
    clearTokens();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth/')) {
        // This module has no router context; navigation occurs only after the
        // current failed session has been durably fenced.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = '/auth/login';
    }
}

function retryWith(request: SessionBoundRequest, snapshot: SessionSnapshot) {
    if (!snapshot.accessToken) throw staleSessionError();
    request.__awoofRetried = true;
    request.__awoofCredentials = {
        accessToken: snapshot.accessToken,
        refreshToken: snapshot.refreshToken,
    };
    setAuthorization(request, snapshot.accessToken);
    return apiClient(request);
}

apiClient.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        const request = config as SessionBoundRequest;
        if (!request.__awoofSession) {
            const started = getSessionSnapshot();
            request.__awoofSession = started;
            request.__awoofCredentials = {
                accessToken: started.accessToken,
                refreshToken: started.refreshToken,
            };
            setAuthorization(request, started.accessToken);
        }
        applyMultipartHeader(request);
        return request;
    },
    (error) => Promise.reject(error),
);

apiClient.interceptors.response.use(
    (response) => response,
    async (error) => {
        const request = error.config as SessionBoundRequest | undefined;
        if (error.response?.status !== 401 || !request) return Promise.reject(error);

        const started = request.__awoofSession;
        const actual = request.__awoofCredentials;
        if (!started || !actual || !isCurrentSession(started)) return Promise.reject(error);

        if (request.__awoofRetried) {
            clearOnlyCurrentFailedSession(request);
            return Promise.reject(error);
        }

        const current = getSessionSnapshot();
        if (current.accessToken !== actual.accessToken || current.refreshToken !== actual.refreshToken) {
            if (!isCurrentSession(started)) return Promise.reject(error);
            try {
                return retryWith(request, current);
            } catch {
                return Promise.reject(error);
            }
        }

        try {
            await refreshFor(started);
            if (!isCurrentSession(started)) throw staleSessionError();
            return retryWith(request, getSessionSnapshot());
        } catch {
            clearOnlyCurrentFailedSession(request);
            return Promise.reject(error);
        }
    },
);

export default apiClient;
