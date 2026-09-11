export function redemptionUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
        return url.href;
    } catch { return null; }
}

export function dealUnavailable(deal: { deal_type?: string; vendor_payment_method?: string; stock: number } | null): boolean {
    return Boolean(deal && (deal.vendor_payment_method === 'vendor_website' || deal.deal_type === 'voucher' || !Number.isFinite(deal.stock) || deal.stock <= 0));
}
