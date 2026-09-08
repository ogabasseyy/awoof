export function redemptionUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
        return url.href;
    } catch { return null; }
}

export function dealUnavailable(deal: { deal_type?: string; stock: number } | null): boolean {
    return Boolean(deal && (!Number.isFinite(deal.stock) || deal.stock <= 0));
}
