/**
 * Password Service
 * 
 * Handles password hashing and verification
 * Follows Single Responsibility Principle - only handles password operations
 */

import bcrypt from 'bcryptjs';

/**
 * Password Service
 * Handles password hashing and comparison (bcryptjs = pure JS, no native build)
 */
class PasswordService {
    private readonly saltRounds = 12;

    /**
     * Hash a password
     */
    public async hashPassword(password: string): Promise<string> {
        return bcrypt.hash(password, this.saltRounds);
    }

    /**
     * Compare password with hash
     */
    public async comparePassword(
        password: string,
        hash: string
    ): Promise<boolean> {
        return bcrypt.compare(password, hash);
    }

    /**
     * Check if password meets requirements
     */
    public validatePassword(password: string): {
        valid: boolean;
        errors: string[];
    } {
        const errors: string[] = [];

        if (password.length < 8) {
            errors.push('Password must be at least 8 characters long');
        }

        if (!/[A-Z]/.test(password)) {
            errors.push('Password must contain at least one uppercase letter');
        }

        if (!/[a-z]/.test(password)) {
            errors.push('Password must contain at least one lowercase letter');
        }

        if (!/[0-9]/.test(password)) {
            errors.push('Password must contain at least one number');
        }

        if (!/[!@#$%^&*(),.?":\{\}|<>\[\]\-_=+~`]/.test(password)) {
            errors.push('Password must contain at least one special character');
        }

        return {
            valid: errors.length === 0,
            errors,
        };
    }
}

export const passwordService = new PasswordService();

