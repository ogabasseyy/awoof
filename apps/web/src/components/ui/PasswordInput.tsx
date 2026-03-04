'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type PasswordInputProps = React.ComponentProps<typeof Input>;

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
    ({ className, ...props }, ref) => {
        const [showPassword, setShowPassword] = React.useState(false);

        return (
            <div className="relative">
                <Input
                    ref={ref}
                    type={showPassword ? 'text' : 'password'}
                    className={cn('pr-9', className)}
                    {...props}
                />
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 rounded p-1"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                    {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                    ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                    )}
                </button>
            </div>
        );
    }
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
