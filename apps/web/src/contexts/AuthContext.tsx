/**
 * Authentication Context
 *
 * Provides authentication state and methods throughout the app
 */

'use client';

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useMemo,
    ReactNode,
} from 'react';
import {
    User,
    storeTokens,
    clearTokens,
    getUserFromToken,
    isAuthenticated as checkAuth,
} from '@/lib/auth';
import apiClient from '@/lib/api-client';

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    login: (
        email: string,
        password: string,
        requiredRole?: 'admin' | 'vendor' | 'student',
        rememberMe?: boolean
    ) => Promise<void>;
    register: (
        email: string,
        password: string,
        name: string,
        role: 'student' | 'vendor'
    ) => Promise<void>;
    logout: () => Promise<void>;
    refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function redirectAfterAuth(path: string) {
    if (typeof window !== 'undefined') {
        window.location.assign(path);
    }
}

function getSafeStudentRedirect(): string {
    if (typeof window === 'undefined') return '/marketplace';
    const candidate = new URLSearchParams(window.location.search).get('redirect');
    if (!candidate) return '/marketplace';
    try {
        const resolved = new URL(candidate, window.location.origin);
        return resolved.origin === window.location.origin
            ? `${resolved.pathname}${resolved.search}${resolved.hash}`
            : '/marketplace';
    } catch {
        return '/marketplace';
    }
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const initAuth = async () => {
            if (checkAuth()) {
                const userFromToken = getUserFromToken();
                if (userFromToken) {
                    try {
                        const response = await apiClient.get('/auth/me');
                        setUser(response.data.data);
                    } catch {
                        setUser(userFromToken);
                    }
                }
            }
            setIsLoading(false);
        };

        initAuth();
    }, []);

    const login = useCallback(
        async (
            email: string,
            password: string,
            requiredRole?: 'admin' | 'vendor' | 'student',
            rememberMe: boolean = false
        ) => {
            const requestBody: {
                email: string;
                password: string;
                role?: string;
                rememberMe?: boolean;
            } = { email, password, rememberMe };
            if (requiredRole) {
                requestBody.role = requiredRole;
            }
            const response = await apiClient.post('/auth/login', requestBody);
            const { tokens, user: userData } = response.data.data;

            storeTokens(tokens);
            setUser(userData);

            if (userData.role === 'vendor') {
                redirectAfterAuth('/vendor/dashboard');
            } else if (userData.role === 'student') {
                redirectAfterAuth(getSafeStudentRedirect());
            } else if (userData.role === 'admin') {
                redirectAfterAuth('/admin/dashboard');
            } else {
                redirectAfterAuth('/');
            }
        },
        []
    );

    const register = useCallback(
        async (email: string, password: string, name: string, role: 'student' | 'vendor') => {
            const response = await apiClient.post('/auth/register', {
                email,
                password,
                name,
                role,
            });
            const { tokens, user: userData } = response.data.data;

            storeTokens(tokens);
            setUser(userData);

            if (userData.role === 'vendor' && response.data.data.requiresEmailVerification) {
                return;
            } else if (userData.role === 'vendor') {
                redirectAfterAuth('/vendor/dashboard');
            } else if (userData.role === 'student') {
                redirectAfterAuth('/marketplace');
            } else {
                redirectAfterAuth('/');
            }
        },
        []
    );

    const logout = useCallback(async () => {
        try {
            await apiClient.post('/auth/logout');
        } catch {
            // Ignore errors on logout
        } finally {
            clearTokens();
            setUser(null);

            if (typeof window !== 'undefined') {
                const currentPath = window.location.pathname;
                if (currentPath.startsWith('/admin')) {
                    redirectAfterAuth('/auth/admin/login');
                } else if (currentPath.startsWith('/vendor')) {
                    redirectAfterAuth('/auth/vendor/login');
                } else if (currentPath.startsWith('/student')) {
                    redirectAfterAuth('/auth/student/login');
                } else {
                    redirectAfterAuth('/');
                }
            }
        }
    }, []);

    const refreshUser = useCallback(async () => {
        if (!checkAuth()) return;
        try {
            const response = await apiClient.get('/auth/me');
            setUser(response.data.data);
        } catch {
            clearTokens();
            setUser(null);
        }
    }, []);

    const value = useMemo<AuthContextType>(
        () => ({
            user,
            isAuthenticated: !!user,
            isLoading,
            login,
            register,
            logout,
            refreshUser,
        }),
        [user, isLoading, login, register, logout, refreshUser]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
