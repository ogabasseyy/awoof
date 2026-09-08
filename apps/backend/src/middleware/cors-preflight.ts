import type { Request } from 'express';

/** Browser negotiation must not consume the quota for actual user actions. */
export const skipCorsPreflight = (req: Request): boolean => req.method === 'OPTIONS';
