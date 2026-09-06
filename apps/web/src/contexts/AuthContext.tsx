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
    type User,
} from '@/lib/auth';
import apiClient, { publicApiClient } from '@/lib/api-client';
import {
    parseAuthenticationResponse,
    parseCurrentAccountResponse,
    type AuthenticationResponse,
} from '@/lib/auth-response';
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
const AUTH_OPERATION_SUPERSEDED_MESSAGE = 'This authentication request was superseded.';

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
        const isCurrentRead = (): boolean => {
            const current = getSessionSnapshot();
            return mountedRef.current
                && operation === operationRef.current
                && current.generation === started.generation;
        };
        if (!started.accessToken) {
            if (mountedRef.current && operation === operationRef.current) {
                setUser(null);
                const blocked = isSessionStorageQuarantined();
                setIsLoading(blocked);
                setError(blocked ? STORAGE_FAILURE_MESSAGE : null);
            }
            return;
        }

        if (showLoading && mountedRef.current) setIsLoading(true);
        try {
            const response = await apiClient.get('/auth/me');
            const account = parseCurrentAccountResponse(response.data);
            if (!account) throw new Error('The server returned an invalid current account.');
            if (isCurrentRead()) {
                setUser(account);
                setError(null);
            }
        } catch {
            if (isCurrentRead()) {
                setUser(null);
                setError(ACCOUNT_FAILURE_MESSAGE);
            }
        } finally {
            if (isCurrentRead()) {
                setIsLoading(isSessionStorageQuarantined());
            }
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        // Reconcile first: an initial legacy migration/active envelope can
        // notify synchronously, so it must happen before subscribing.
        getSessionSnapshot();
        const unsubscribe = subscribeSessionChanges(() => {
            if (ownCommitRef.current) return;
            setUser(null);
            void loadCurrentUser(true);
        });
        const initialOperation = operationRef.current;
        queueMicrotask(() => {
            if (operationRef.current === initialOperation) void loadCurrentUser(true);
        });
        return () => {
            mountedRef.current = false;
            operationRef.current += 1;
            unsubscribe();
        };
    }, [loadCurrentUser]);

    const commitAuthenticatedResponse = useCallback((authentication: AuthenticationResponse, requiredRole?: User['role']): User => {
        const { user: account, tokens } = authentication;
        if (requiredRole && account.role !== requiredRole) {
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

        const authentication = parseAuthenticationResponse(response.data);
        if (!authentication) throw new Error('The server returned an invalid authentication response.');
        let account: User;
        try {
            account = commitAuthenticatedResponse(authentication, requiredRole);
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
        setIsLoading(false);
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
            throw new Error(AUTH_OPERATION_SUPERSEDED_MESSAGE);
        }

        const authentication = parseAuthenticationResponse(response.data);
        if (!authentication) throw new Error('The server returned an invalid authentication response.');
        let account: User;
        try {
            account = commitAuthenticatedResponse(authentication, role);
        } catch (commitError) {
            if (mountedRef.current && operation === operationRef.current) {
                setUser(null);
                setError(ACCOUNT_FAILURE_MESSAGE);
            }
            throw commitError;
        }

        if (!mountedRef.current || operation !== operationRef.current) {
            throw new Error(AUTH_OPERATION_SUPERSEDED_MESSAGE);
        }
        setIsLoading(false);
        setUser(account);
        if (account.role === 'vendor' && authentication.requiresEmailVerification) return;
        redirectAfterAuth(account.role === 'student' ? '/marketplace' : destinationFor(account));
    }, [commitAuthenticatedResponse]);

    const logout = useCallback(async (): Promise<void> => {
        const captured = getSessionSnapshot();
        const role = user?.role;
        operationRef.current += 1;
        clearTokens();
        const blocked = isSessionStorageQuarantined();
        if (mountedRef.current) {
            setUser(null);
            setIsLoading(blocked);
            setError(blocked ? STORAGE_FAILURE_MESSAGE : null);
        }

        if (!blocked) {
            if (role === 'admin') redirectAfterAuth('/auth/admin/login');
            else if (role === 'vendor') redirectAfterAuth('/auth/vendor/login');
            else if (role === 'student') redirectAfterAuth('/auth/student/login');
            else redirectAfterAuth('/');
        }

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
                    <p>{error}</p>
                    {error === STORAGE_FAILURE_MESSAGE && (
                        <button
                            type="button"
                            className="mt-2 rounded border border-red-300 px-2 py-1 font-medium hover:bg-red-100"
                            onClick={() => { void logout(); }}
                        >
                            Retry sign out
                        </button>
                    )}
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
