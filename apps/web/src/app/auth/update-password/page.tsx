/**
 * Update Password Page
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import apiClient from '@/lib/api-client';
import { useAuth } from '@/contexts/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const updatePasswordSchema = z.object({
    oldPassword: z.string().min(1, 'Current password is required'),
    password: z.string().min(8, 'New password must be at least 8 characters'),
    confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
});

type UpdatePasswordFormData = z.infer<typeof updatePasswordSchema>;

export default function UpdatePasswordPage() {
    const router = useRouter();
    const { logout } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const {
        register,
        handleSubmit,
        reset,
        formState: { errors },
    } = useForm<UpdatePasswordFormData>({
        resolver: zodResolver(updatePasswordSchema),
    });

    const onSubmit = async (data: UpdatePasswordFormData) => {
        try {
            setIsLoading(true);
            setError(null);
            await apiClient.post('/auth/update-password', {
                oldPassword: data.oldPassword,
                newPassword: data.password,
            });
            setSuccess(true);

            reset({ oldPassword: '', password: '', confirmPassword: '' });

            setTimeout(() => {
                logout();
                router.push('/auth/login?updated=success');
            }, 2000);
        } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            setError(err.response?.data?.error?.message || 'Failed to update password. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <ProtectedRoute>
            <AuthShell
                role="generic"
                title="Update Password"
                subtitle="Enter your current password and choose a new one."
            >
                {success && (
                    <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-xl text-sm">
                        Password updated successfully! You will be logged out shortly.
                    </div>
                )}

                {error && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                    <div>
                        <Label htmlFor="oldPassword">Current Password</Label>
                        <Input
                            id="oldPassword"
                            type="password"
                            placeholder="Enter your current password"
                            {...register('oldPassword')}
                            aria-invalid={errors.oldPassword ? 'true' : 'false'}
                        />
                        {errors.oldPassword && (
                            <p className="mt-1 text-sm text-red-600">{errors.oldPassword.message}</p>
                        )}
                    </div>

                    <div>
                        <Label htmlFor="password">New Password</Label>
                        <Input
                            id="password"
                            type="password"
                            placeholder="At least 8 characters"
                            {...register('password')}
                            aria-invalid={errors.password ? 'true' : 'false'}
                        />
                        {errors.password && (
                            <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
                        )}
                    </div>

                    <div>
                        <Label htmlFor="confirmPassword">Confirm New Password</Label>
                        <Input
                            id="confirmPassword"
                            type="password"
                            placeholder="Re-enter your new password"
                            {...register('confirmPassword')}
                            aria-invalid={errors.confirmPassword ? 'true' : 'false'}
                        />
                        {errors.confirmPassword && (
                            <p className="mt-1 text-sm text-red-600">{errors.confirmPassword.message}</p>
                        )}
                    </div>

                    <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading || success}>
                        {isLoading ? 'Updating...' : 'Update Password'}
                    </Button>
                </form>
            </AuthShell>
        </ProtectedRoute>
    );
}
