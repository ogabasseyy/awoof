/**
 * PriceInput – shows comma-separated value while typing, reports number on change.
 * Use with react-hook-form Controller so the field value stays numeric for submit.
 */

'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

function formatPriceDisplay(value: number | undefined): string {
    if (value === undefined || value === null || Number.isNaN(value)) return '';
    if (value === 0) return '';
    const s = value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
    return s;
}

function parsePriceInput(raw: string): number {
    const cleaned = raw.replace(/,/g, '').trim();
    if (cleaned === '' || cleaned === '.') return 0;
    const n = parseFloat(cleaned);
    return Number.isNaN(n) ? 0 : n;
}

/** Format only the integer part with commas, keep decimals as-is. */
function formatAsTyping(raw: string): string {
    const noCommas = raw.replace(/,/g, '');
    const parts = noCommas.split('.');
    if (parts.length > 2) return formatAsTyping(parts[0] + '.' + parts.slice(1).join(''));
    const intPart = parts[0].replace(/\D/g, '');
    const decPart = parts[1];
    const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (decPart === undefined) return formattedInt;
    return formattedInt + '.' + decPart.replace(/\D/g, '').slice(0, 2);
}

export type PriceInputProps = Omit<
    React.ComponentProps<typeof Input>,
    'value' | 'onChange' | 'type'
> & {
    onFocus?: React.FocusEventHandler<HTMLInputElement>;
    value: number | undefined;
    onChange: (value: number) => void;
};

const PriceInput = React.forwardRef<HTMLInputElement, PriceInputProps>(
    ({ value, onChange, onBlur, onFocus, className, ...props }, ref) => {
        const [display, setDisplay] = React.useState('');
        const isFocusedRef = React.useRef(false);
        const isControlled = value !== undefined && value !== null && !Number.isNaN(value);

        // Sync from form value only when not focused (e.g. initial load, reset, or after blur)
        React.useEffect(() => {
            if (!isControlled || isFocusedRef.current) return;
            setDisplay(formatPriceDisplay(value));
        }, [value, isControlled]);

        const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
            isFocusedRef.current = true;
            onFocus?.(e);
        };

        const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
            const raw = e.target.value;
            if (raw === '') {
                setDisplay('');
                onChange(0);
                return;
            }
            const formatted = formatAsTyping(raw);
            setDisplay(formatted);
            const parsed = parsePriceInput(formatted);
            onChange(parsed);
        };

        const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
            isFocusedRef.current = false;
            const num = parsePriceInput(display);
            setDisplay(formatPriceDisplay(num));
            onChange(num);
            onBlur?.(e);
        };

        return (
            <Input
                ref={ref}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={display}
                onChange={handleChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                className={cn(className)}
                {...props}
            />
        );
    }
);
PriceInput.displayName = 'PriceInput';

export { PriceInput };
