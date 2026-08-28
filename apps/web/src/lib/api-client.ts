/**
 * API Client
 *
 * Centralized HTTP client with interceptors for authentication
 */

import axios from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export function getImageUrl(imagePath: string | null | undefined): string | null {
    if (!imagePath) return null;

    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        return imagePath;
    }

    return `${API_URL}${imagePath}`;
}

const apiClient: AxiosInstance = axios.create({
    baseURL: `${API_URL}/api`,
    headers: {
        'Content-Type': 'application/json',
    },
});

/** Shared refresh promise so parallel 401s don't stampede /auth/refresh */
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return null;

    const response = await axios.post(`${API_URL}/api/auth/refresh`, {
        refreshToken,
    });

    const { accessToken, refreshToken: newRefreshToken } =
        response.data.data || response.data;

    if (!accessToken) return null;

    localStorage.setItem('accessToken', accessToken);
    if (newRefreshToken) {
        localStorage.setItem('refreshToken', newRefreshToken);
    }
    return accessToken;
}

function getSharedRefresh(): Promise<string | null> {
    if (!refreshPromise) {
        refreshPromise = refreshAccessToken().finally(() => {
            refreshPromise = null;
        });
    }
    return refreshPromise;
}

apiClient.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        if (typeof window !== 'undefined') {
            const token = localStorage.getItem('accessToken');
            if (token && config.headers) {
                config.headers.Authorization = `Bearer ${token}`;
            }
        }
        if (config.data instanceof FormData && config.headers) {
            if (typeof config.headers.delete === 'function') {
                config.headers.delete('Content-Type');
            } else {
                delete config.headers['Content-Type'];
            }
        }
        return config;
    },
    (error) => Promise.reject(error)
);

apiClient.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
            originalRequest._retry = true;

            try {
                if (typeof window === 'undefined') {
                    return Promise.reject(error);
                }

                const accessToken = await getSharedRefresh();
                if (accessToken) {
                    originalRequest.headers.Authorization = `Bearer ${accessToken}`;
                    return apiClient(originalRequest);
                }
            } catch {
                // fall through to clear
            }

            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth/')) {
                window.location.assign('/auth/login');
            }
            return Promise.reject(error);
        }

        return Promise.reject(error);
    }
);

export default apiClient;
