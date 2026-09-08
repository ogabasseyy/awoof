/** Start before clearing local state: route guards may immediately unload it. */
export async function revokeLogoutSession(
    apiBase: string,
    accessToken: string | null,
    refreshToken: string | null,
    request: typeof fetch = fetch,
): Promise<boolean> {
    if (!accessToken && !refreshToken) return true;
    try {
        const response = await request(`${apiBase}/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
            body: refreshToken ? JSON.stringify({ refreshToken }) : undefined,
            keepalive: true,
            signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
    } catch { return false; }
}
