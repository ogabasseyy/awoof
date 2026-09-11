/**
 * Formatting utilities for numbers and currency
 */

/**
 * Format a number with comma separators
 * @param amount - The number to format
 * @returns Formatted string with commas (e.g., "1,000,000")
 */
export function formatNumber(amount: number | string): string {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num)) return '0';
    return num.toLocaleString('en-US');
}

/**
 * Format currency with NGN symbol and comma separators
 * @param amount - The amount to format
 * @param showSymbol - Whether to show the currency symbol (default: true)
 * @returns Formatted currency string (e.g., "₦1,000,000" or "1,000,000")
 */
export function formatCurrency(amount: number | string, showSymbol: boolean = true): string {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num)) return showSymbol ? '₦0' : '0';

    const formatted = num.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });

    return showSymbol ? `₦${formatted}` : formatted;
}

/** Totals with unrecorded historical credits must not look complete. */
export function formatSavings(total: number | null | undefined, recorded?: number): string {
    if (total != null) return formatCurrency(total);
    return recorded ? `${formatCurrency(recorded)} recorded · partial` : 'Unknown';
}

/**
 * Format currency using Intl.NumberFormat (alternative method)
 * @param amount - The amount to format
 * @returns Formatted currency string using Intl API
 */
export function formatCurrencyIntl(amount: number | string): string {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num)) return '₦0';

    return new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: 'NGN',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(num);
}
