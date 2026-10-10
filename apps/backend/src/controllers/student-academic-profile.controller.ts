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
import { config } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
    isAcademicProfileCollectionEnabled,
    readAcademicProfile,
    saveAcademicProfile,
} from '../services/academic-profile/academic-profile.service.js';
import type { AcademicProfileProjection } from '../services/academic-profile/academic-profile.types.js';
import {
    estimateGraduationYearForStudent,
    searchInstitutionsForStudent,
    searchProgrammesForStudent,
    type CataloguePage,
    type EstimateResult,
    type InstitutionCatalogueItem,
    type ProgrammeCatalogueItem,
} from '../services/academic-profile/academic-programme-reference.service.js';

export class StudentAcademicProfileController {
    private readonly readProfile: (userId: string) => Promise<AcademicProfileProjection>;
    private readonly saveProfile: (userId: string, body: unknown) => Promise<AcademicProfileProjection>;
    private readonly searchInstitutions: (userId: string, query: unknown) => Promise<CataloguePage<InstitutionCatalogueItem>>;
    private readonly searchProgrammes: (userId: string, query: unknown) => Promise<CataloguePage<ProgrammeCatalogueItem>>;
    private readonly estimateYear: (userId: string, body: unknown) => Promise<EstimateResult>;
    private readonly collectionEnabled: () => boolean;

    constructor(dependencies: {
        readAcademicProfile?: (userId: string) => Promise<AcademicProfileProjection>;
        saveAcademicProfile?: (userId: string, body: unknown) => Promise<AcademicProfileProjection>;
        searchInstitutions?: (userId: string, query: unknown) => Promise<CataloguePage<InstitutionCatalogueItem>>;
        searchProgrammes?: (userId: string, query: unknown) => Promise<CataloguePage<ProgrammeCatalogueItem>>;
        estimateGraduationYear?: (userId: string, body: unknown) => Promise<EstimateResult>;
        isCollectionEnabled?: () => boolean;
    } = {}) {
        // The application pool opens only when a profile response is served,
        // never merely by mounting the router.
        this.readProfile = dependencies.readAcademicProfile
            ?? ((userId: string) => readAcademicProfile(db.getPool(), userId));
        this.saveProfile = dependencies.saveAcademicProfile
            ?? ((userId: string, body: unknown) => saveAcademicProfile(db.getPool(), userId, body));
        this.searchInstitutions = dependencies.searchInstitutions
            ?? ((userId: string, query: unknown) => searchInstitutionsForStudent(db.getPool(), userId, query));
        this.searchProgrammes = dependencies.searchProgrammes
            ?? ((userId: string, query: unknown) => searchProgrammesForStudent(db.getPool(), userId, query));
        this.estimateYear = dependencies.estimateGraduationYear
            ?? ((userId: string, body: unknown) => estimateGraduationYearForStudent(db.getPool(), userId, body));
        this.collectionEnabled = dependencies.isCollectionEnabled
            ?? (() => isAcademicProfileCollectionEnabled(config.academicProfile));
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

    private requireCollection(): void {
        if (!this.collectionEnabled()) {
            throw new ForbiddenError('Academic profile collection is not currently available');
        }
    }

    /**
     * Search the institution catalogue scoped to the authenticated student.
     * Catalogue membership is not a supported-institution claim.
     */
    public async searchAcademicInstitutions(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }
        this.requireCollection();
        const page = await this.searchInstitutions(req.user.userId, req.query);
        success(res, {
            message: 'Academic institutions retrieved successfully',
            data: page,
        });
    }

    /**
     * Search the reviewed programme catalogue scoped to the authenticated student.
     */
    public async searchAcademicProgrammes(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }
        this.requireCollection();
        const page = await this.searchProgrammes(req.user.userId, req.query);
        success(res, {
            message: 'Academic programmes retrieved successfully',
            data: page,
        });
    }

    /**
     * Compute an advisory graduation-year estimate without persisting it.
     */
    public async estimateAcademicGraduationYear(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }
        this.requireCollection();
        const result = await this.estimateYear(req.user.userId, req.body);
        success(res, {
            message: 'Academic graduation estimate computed successfully',
            data: result,
        });
    }
}
