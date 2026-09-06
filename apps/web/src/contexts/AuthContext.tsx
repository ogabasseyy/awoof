/** Provides server-derived current-account state throughout the app. */

'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import {
    clearTokens,
    getSessionSnapshot,
    isSessionStorageQuarantined,
    storeTokens,
    subscribeSessionChanges,
    type TokenPair,
    type User,
} from '@/lib/auth';
import apiClient, { publicApiClient } from '@/lib/api-client';
import { resolveStudentReturn } from '@/lib/student-return';

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    error: string | null;
    login: (
        email: string,
        password: string,
        requiredRole?: 'admin' | 'vendor' | 'student',
        rememberMe?: boolean,
    ) => Promise<void>;
    register: (
        email: string,
        password: string,
        name: string,
        role: 'student' | 'vendor',
    ) => Promise<void>;
    logout: () => Promise<void>;
    refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_FAILURE_MESSAGE = 'We could not save your signed-out state on this device. Please close this tab before using a shared device.';
const ACCOUNT_FAILURE_MESSAGE = 'We could not confirm your account. Please sign in again.';

function isRole(value: unknown): value is User['role'] {
    return value === 'student' || value === 'vendor' || value === 'admin';
}

function isUser(value: unknown): value is User {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const user = value as Partial<User>;
    return typeof user.id === 'string'
        && user.id.length > 0
        && typeof user.email === 'string'
        && user.email.length > 0
        && isRole(user.role)
        && (user.verificationStatus === undefined
            || user.verificationStatus === 'unverified'
            || user.verificationStatus === 'verified'
            || user.verificationStatus === 'expired');
}

function isTokenPair(value: unknown): value is TokenPair {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const tokens = value as Partial<TokenPair>;
    return typeof tokens.accessToken === 'string'
        && tokens.accessToken.length > 0
        && typeof tokens.refreshToken === 'string'
        && tokens.refreshToken.length > 0;
}

function responseData(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function redirectAfterAuth(path: string): void {
    if (typeof window !== 'undefined') window.location.href = path;
}

function destinationFor(user: User): string {
    if (user.role === 'vendor') return '/vendor/dashboard';
    if (user.role === 'admin') return '/admin/dashboard';
    if (typeof window === 'undefined') return '/marketplace';
    return resolveStudentReturn(
        new URLSearchParams(window.location.search).get('redirect'),
        window.location.origin,
    );
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const mountedRef = useRef(false);
    const operationRef = useRef(0);
    const ownCommitRef = useRef(false);

    const loadCurrentUser = useCallback(async (showLoading: boolean): Promise<void> => {
        const operation = ++operationRef.current;
        const started = getSessionSnapshot();
        if (!started.accessToken) {
            if (mountedRef.current && operation === operationRef.current) {
                setUser(null);
                if (showLoading) setIsLoading(false);
            }
            return;
        }

        if (showLoading && mountedRef.current) setIsLoading(true);
        try {
            const response = await apiClient.get('/auth/me');
            const account = responseData(response.data)?.data;
            if (!isUser(account)) throw new Error('The server returned an invalid current account.');
            if (
                mountedRef.current
                && operation === operationRef.current
                && getSessionSnapshot().generation === started.generation
            ) {
                setUser(account);
                setError(null);
            }
        } catch {
            if (
                mountedRef.current
                && operation === operationRef.current
                && getSessionSnapshot().generation === started.generation
            ) {
                setUser(null);
                setError(ACCOUNT_FAILURE_MESSAGE);
            }
        } finally {
            if (mountedRef.current && operation === operationRef.current && showLoading) {
                setIsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        const unsubscribe = subscribeSessionChanges(() => {
            if (ownCommitRef.current) return;
            void loadCurrentUser(false);
        });
        queueMicrotask(() => { void loadCurrentUser(true); });
        return () => {
            mountedRef.current = false;
            operationRef.current += 1;
            unsubscribe();
        };
    }, [loadCurrentUser]);

    const commitAuthenticatedResponse = useCallback((data: unknown, requiredRole?: User['role']): User => {
        const payload = responseData(data);
        const account = payload?.user;
        const tokens = payload?.tokens;
        if (!isUser(account) || !isTokenPair(tokens) || (requiredRole && account.role !== requiredRole)) {
            throw new Error('The server returned an invalid authentication response.');
        }

        ownCommitRef.current = true;
        try {
            storeTokens(tokens);
            const persisted = getSessionSnapshot();
            if (persisted.accessToken !== tokens.accessToken || persisted.refreshToken !== tokens.refreshToken) {
                throw new Error('The session could not be persisted.');
            }
        } finally {
            ownCommitRef.current = false;
        }
        return account;
    }, []);

    const login = useCallback(async (
        email: string,
        password: string,
        requiredRole?: User['role'],
        rememberMe = false,
    ): Promise<void> => {
        const operation = ++operationRef.current;
        const started = getSessionSnapshot();
        setError(null);
        const requestBody: { email: string; password: string; role?: string; rememberMe: boolean } = {
            email,
            password,
            rememberMe,
        };
        if (requiredRole) requestBody.role = requiredRole;
        const response = await publicApiClient.post('/auth/login', requestBody);
        const beforeCommit = getSessionSnapshot();
        if (
            !mountedRef.current
            || operation !== operationRef.current
            || beforeCommit.generation !== started.generation
        ) {
            return;
        }

        let account: User;
        try {
            account = commitAuthenticatedResponse(response.data, requiredRole);
        } catch (commitError) {
            if (mountedRef.current && operation === operationRef.current) {
                setUser(null);
                setError(ACCOUNT_FAILURE_MESSAGE);
            }
            throw commitError;
        }

        const persisted = getSessionSnapshot();
        if (
            !mountedRef.current
            || operation !== operationRef.current
            || !persisted.accessToken
            || !persisted.refreshToken
        ) {
            return;
        }
        setUser(account);
        redirectAfterAuth(destinationFor(account));
    }, [commitAuthenticatedResponse]);

    const register = useCallback(async (
        email: string,
        password: string,
        name: string,
        role: 'student' | 'vendor',
    ): Promise<void> => {
        const operation = ++operationRef.current;
        const started = getSessionSnapshot();
        setError(null);
        const response = await publicApiClient.post('/auth/register', { email, password, name, role });
        const beforeCommit = getSessionSnapshot();
        if (
            !mountedRef.current
            || operation !== operationRef.current
            || beforeCommit.generation !== started.generation
        ) {
            return;
        }

        let account: User;
        try {
            account = commitAuthenticatedResponse(response.data, role);
        } catch (commitError) {
            if (mountedRef.current && operation === operationRef.current) {
                setUser(null);
                setError(ACCOUNT_FAILURE_MESSAGE);
            }
            throw commitError;
        }

        const payload = responseData(response.data);
        if (!mountedRef.current || operation !== operationRef.current) return;
        setUser(account);
        if (account.role === 'vendor' && payload?.requiresEmailVerification === true) return;
        redirectAfterAuth(account.role === 'student' ? '/marketplace' : destinationFor(account));
    }, [commitAuthenticatedResponse]);

    const logout = useCallback(async (): Promise<void> => {
        const captured = getSessionSnapshot();
        const role = user?.role;
        operationRef.current += 1;
        clearTokens();
        if (mountedRef.current) {
            setUser(null);
            setIsLoading(false);
            setError(isSessionStorageQuarantined() ? STORAGE_FAILURE_MESSAGE : null);
        }

        if (role === 'admin') redirectAfterAuth('/auth/admin/login');
        else if (role === 'vendor') redirectAfterAuth('/auth/vendor/login');
        else if (role === 'student') redirectAfterAuth('/auth/student/login');
        else redirectAfterAuth('/');

        if (!captured.accessToken) return;
        try {
            await publicApiClient.post('/auth/logout', undefined, {
                headers: { Authorization: `Bearer ${captured.accessToken}` },
            });
        } catch {
            // Local authority was already fenced. This best-effort server call
            // must never refresh, clear, or navigate a newer browser session.
        }
    }, [user]);

    const refreshUser = useCallback(async (): Promise<void> => {
        await loadCurrentUser(false);
    }, [loadCurrentUser]);

    const value = useMemo<AuthContextType>(() => ({
        user,
        isAuthenticated: !!user,
        isLoading,
        error,
        login,
        register,
        logout,
        refreshUser,
    }), [user, isLoading, error, login, register, logout, refreshUser]);

    return (
        <AuthContext.Provider value={value}>
            {children}
            {error && (
                <div role="alert" className="fixed inset-x-4 top-4 z-[100] rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 shadow-sm sm:left-auto sm:right-4 sm:max-w-md">
                    {error}
                </div>
            )}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
    return context;
}
