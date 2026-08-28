/**
 * Register Page
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/contexts/AuthContext';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Link from 'next/link';

const registerSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
    role: z.enum(['student', 'vendor']),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
});

type RegisterFormData = z.infer<typeof registerSchema>;

export default function RegisterPage() {
    const router = useRouter();
    const { register: registerUser } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<RegisterFormData>({
        resolver: zodResolver(registerSchema),
        defaultValues: {
            role: 'student',
        },
    });

    const onSubmit = async (data: RegisterFormData) => {
        try {
            setIsLoading(true);
            setError(null);
            await registerUser(data.email, data.password, data.name, data.role);
            router.push('/');
        } catch (err: unknown) {
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Registration failed. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <AuthShell
            role="generic"
            title="Create Account"
            subtitle="Join Awoof as a student or vendor."
            maxWidthClass="max-w-lg"
            footer={
                <p className="text-center text-sm text-slate-600">
                    Already have an account?{' '}
                    <Link href="/auth/login" className="text-primary hover:underline font-medium">
                        Sign in
                    </Link>
                </p>
            }
        >
            {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div>
                    <Label htmlFor="name">Full Name</Label>
                    <Input
                        id="name"
                        type="text"
                        placeholder="John Doe"
                        {...register('name')}
                        aria-invalid={errors.name ? 'true' : 'false'}
                    />
                    {errors.name && (
                        <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="email">Email</Label>
                    <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        {...register('email')}
                        aria-invalid={errors.email ? 'true' : 'false'}
                    />
                    {errors.email && (
                        <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="role">Account Type</Label>
                    <div className="mt-2 flex gap-4">
                        <label className="flex items-center">
                            <input
                                type="radio"
                                value="student"
                                {...register('role')}
                                className="mr-2"
                            />
                            Student
                        </label>
                        <label className="flex items-center">
                            <input
                                type="radio"
                                value="vendor"
                                {...register('role')}
                                className="mr-2"
                            />
                            Vendor
                        </label>
                    </div>
                    {errors.role && (
                        <p className="mt-1 text-sm text-red-600">{errors.role.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="password">Password</Label>
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
                    <Label htmlFor="confirmPassword">Confirm Password</Label>
                    <Input
                        id="confirmPassword"
                        type="password"
                        placeholder="Re-enter your password"
                        {...register('confirmPassword')}
                        aria-invalid={errors.confirmPassword ? 'true' : 'false'}
                    />
                    {errors.confirmPassword && (
                        <p className="mt-1 text-sm text-red-600">{errors.confirmPassword.message}</p>
                    )}
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Creating account...' : 'Create Account'}
                </Button>
            </form>
        </AuthShell>
    );
}
