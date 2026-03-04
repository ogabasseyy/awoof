/**
 * File Upload Configuration
 * 
 * Configures multer for handling file uploads
 */

import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs';

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads', 'vendors');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
        const uniqueName = `${randomUUID()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    },
});

// File filter for images and PDFs
const fileFilter = (_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedMimes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'application/pdf',
    ];

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only images (JPEG, PNG, WebP) and PDFs are allowed.'));
    }
};

// Configure multer
export const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 2 * 1024 * 1024, // 2MB max file size
    },
});

// CSV upload for admin university import (in-memory, max 2MB)
const csvFileFilter = (_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedMimes = [
        'text/csv',
        'application/csv',
        'text/plain',
        'application/vnd.ms-excel',
    ];
    if (allowedMimes.includes(file.mimetype) || file.originalname?.toLowerCase().endsWith('.csv')) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only CSV files are allowed.'));
    }
};

export const csvUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: csvFileFilter,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

// Helper to get file URL
// Returns relative path - frontend should construct full URL using NEXT_PUBLIC_API_URL
export function getFileUrl(filename: string): string {
    return `/uploads/vendors/${filename}`;
}

