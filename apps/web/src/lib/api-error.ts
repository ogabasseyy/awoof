/**
 * Extract a user-facing message from an Axios/API error.
 * Backend shape: { success: false, error: { message: string } }
 */

type ApiErrorShape = {
    response?: {
        data?: {
            message?: string;
            error?: {
                message?: string;
            };
        };
    };
    message?: string;
};

export function getApiErrorMessage(
    error: unknown,
    fallback = 'Something went wrong. Please try again.'
): string {
    const err = error as ApiErrorShape;
    return (
        err.response?.data?.error?.message ||
        err.response?.data?.message ||
        (typeof err.message === 'string' && err.message !== 'Network Error'
            ? err.message
            : null) ||
        fallback
    );
}
