/**
 * Student Academic Profile Controller
 *
 * Authenticated student-owned academic details. The user id always comes from
 * the verified session; the path and body can never address another student.
 * Validation lives in the service boundary so direct callers and HTTP share
 * one strict contract.
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import { UnauthorizedError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
    readAcademicProfile,
    saveAcademicProfile,
} from '../services/academic-profile/academic-profile.service.js';
import type { AcademicProfileProjection } from '../services/academic-profile/academic-profile.types.js';

export class StudentAcademicProfileController {
    private readonly readProfile: (userId: string) => Promise<AcademicProfileProjection>;
    private readonly saveProfile: (userId: string, body: unknown) => Promise<AcademicProfileProjection>;

    constructor(dependencies: {
        readAcademicProfile?: (userId: string) => Promise<AcademicProfileProjection>;
        saveAcademicProfile?: (userId: string, body: unknown) => Promise<AcademicProfileProjection>;
    } = {}) {
        // The application pool opens only when a profile response is served,
        // never merely by mounting the router.
        this.readProfile = dependencies.readAcademicProfile
            ?? ((userId: string) => readAcademicProfile(db.getPool(), userId));
        this.saveProfile = dependencies.saveAcademicProfile
            ?? ((userId: string, body: unknown) => saveAcademicProfile(db.getPool(), userId, body));
    }

    /**
     * Get the authenticated student's academic profile projection.
     */
    public async getAcademicProfile(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }
        const projection = await this.readProfile(req.user.userId);
        success(res, {
            message: 'Academic profile retrieved successfully',
            data: projection,
        });
    }

    /**
     * Save the authenticated student's academic profile patch.
     */
    public async updateAcademicProfile(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }
        const projection = await this.saveProfile(req.user.userId, req.body);
        success(res, {
            message: 'Academic profile saved successfully',
            data: projection,
        });
    }
}
