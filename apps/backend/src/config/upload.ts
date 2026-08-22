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

// Magic byte signatures for file type validation
const MAGIC_BYTES: Record<string, Buffer[]> = {
    'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
    'image/jpg': [Buffer.from([0xFF, 0xD8, 0xFF])],
    'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
    'image/webp': [Buffer.from('RIFF')], // Also check for WEBP at offset 8
    'application/pdf': [Buffer.from('%PDF')],
};

/**
 * Middleware to validate uploaded file magic bytes.
 * Use after multer middleware to verify actual file content matches claimed MIME type.
 */
export function validateFileMagicBytes(req: any, res: any, next: any) {
    if (!req.file && !req.files) return next();

    const files = req.file ? [req.file] : (Array.isArray(req.files) ? req.files : Object.values(req.files).flat());

    for (const file of files as Express.Multer.File[]) {
        if (!file.path) continue; // skip memory storage files

        try {
            const fd = fs.openSync(file.path, 'r');
            const header = Buffer.alloc(12);
            fs.readSync(fd, header, 0, 12, 0);
            fs.closeSync(fd);

            const expectedSigs = MAGIC_BYTES[file.mimetype];
            if (expectedSigs) {
                const valid = expectedSigs.some(sig => {
                    if (file.mimetype === 'image/webp') {
                        // RIFF at start + WEBP at offset 8
                        return header.subarray(0, 4).equals(Buffer.from('RIFF')) &&
                               header.subarray(8, 12).equals(Buffer.from('WEBP'));
                    }
                    return header.subarray(0, sig.length).equals(sig);
                });

                if (!valid) {
                    // Delete the invalid file
                    fs.unlinkSync(file.path);
                    res.status(400).json({
                        success: false,
                        error: { message: 'File content does not match declared type', statusCode: 400 }
                    });
                    return;
                }
            }
        } catch {
            // If we can't read the file, let it through (multer already validated MIME)
        }
    }
    next();
}
