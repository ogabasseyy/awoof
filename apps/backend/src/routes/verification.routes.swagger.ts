/**
 * Swagger documentation for Verification Routes
 * 
 * This file contains OpenAPI/Swagger annotations for verification endpoints
 * Used by swagger-jsdoc to generate API documentation
 */

/**
 * @swagger
 * tags:
 *   - name: Verification
 *     description: Student verification endpoints (4-tier system)
 */

/**
 * @swagger
 * /api/verification/methods/{universityId}:
 *   get:
 *     summary: Get available verification methods for a university
 *     tags: [Verification]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: universityId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: University ID
 *         example: 123e4567-e89b-12d3-a456-426614174000
 *     responses:
 *       200:
 *         description: Verification methods retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         universityId:
 *                           type: string
 *                           format: uuid
 *                         methods:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/VerificationMethod'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */

/**
 * @swagger
 * /api/verification/initiate:
 *   post:
 *     summary: Initiate verification process (determines best method)
 *     tags: [Verification]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - universityId
 *               - ndprConsent
 *             properties:
 *               universityId:
 *                 type: string
 *                 format: uuid
 *                 example: 123e4567-e89b-12d3-a456-426614174000
 *               email:
 *                 type: string
 *                 format: email
 *                 example: student@unilag.edu.ng
 *               registrationNumber:
 *                 type: string
 *                 example: 2019/12345
 *               phoneNumber:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *                 example: +2348012345678
 *               ndprConsent:
 *                 type: boolean
 *                 description: Must be true to proceed
 *                 example: true
 *               studentName:
 *                 type: string
 *                 minLength: 2
 *                 example: John Doe
 *     responses:
 *       200:
 *         description: Verification method determined
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         recommendedMethod:
 *                           type: string
 *                           enum: [portal, email, registration, whatsapp]
 *                         availableMethods:
 *                           type: array
 *                           items:
 *                             type: string
 *                         nextStep:
 *                           type: object
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */

/**
 * @swagger
 * /api/verification/email:
 *   post:
 *     summary: Request email verification (sends magic link)
 *     tags: [Verification]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - universityId
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: student@unilag.edu.ng
 *               universityId:
 *                 type: string
 *                 format: uuid
 *                 example: 123e4567-e89b-12d3-a456-426614174000
 *     responses:
 *       200:
 *         description: Magic link sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         email:
 *                           type: string
 *                         expiresInMinutes:
 *                           type: integer
 *                           example: 15
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */

/**
 * @swagger
 * /api/verification/email/verify:
 *   get:
 *     summary: Verify email via magic link token
 *     tags: [Verification]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: Magic link token from email
 *         example: abc123def456ghi789
 *     responses:
 *       200:
 *         description: Email verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         verified:
 *                           type: boolean
 *                         tokens:
 *                           $ref: '#/components/schemas/Tokens'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/verification/registration:
 *   post:
 *     summary: Check the signed-in student's registration with its configured institution adapter
 *     tags: [Verification]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - registrationNumber
 *               - processingGrantId
 *             properties:
 *               registrationNumber:
 *                 type: string
 *                 example: 2019/12345
 *               processingGrantId:
 *                 type: string
 *                 format: uuid
 *                 description: Current signed-in student's processing-consent grant
 *     responses:
 *       200:
 *         description: Effective eligibility after a strict configured-adapter check
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         eligibility:
 *                           type: object
 *                         reason:
 *                           type: string
 *                           enum: [provider_unknown, provider_unavailable]
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       503:
 *         description: No active supported adapter is configured for the student's institution
 */

/**
 * @swagger
 * /api/verification/whatsapp/request:
 *   post:
 *     summary: Request WhatsApp OTP for verification
 *     tags: [Verification]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phoneNumber
 *               - universityId
 *             properties:
 *               phoneNumber:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *                 example: +2348012345678
 *               universityId:
 *                 type: string
 *                 format: uuid
 *                 example: 123e4567-e89b-12d3-a456-426614174000
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         phoneNumber:
 *                           type: string
 *                         expiresInMinutes:
 *                           type: integer
 *                           example: 5
 *                         note:
 *                           type: string
 *                           description: Optional note if service not configured
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */

/**
 * @swagger
 * /api/verification/whatsapp/verify:
 *   post:
 *     summary: Verify WhatsApp OTP
 *     tags: [Verification]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phoneNumber
 *               - otp
 *             properties:
 *               phoneNumber:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *                 example: +2348012345678
 *               otp:
 *                 type: string
 *                 pattern: '^\d{6}$'
 *                 example: "123456"
 *               universityId:
 *                 type: string
 *                 format: uuid
 *                 example: 123e4567-e89b-12d3-a456-426614174000
 *               studentName:
 *                 type: string
 *                 example: John Doe
 *     responses:
 *       200:
 *         description: OTP verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         verified:
 *                           type: boolean
 *                         tokens:
 *                           $ref: '#/components/schemas/Tokens'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */

/**
 * @swagger
 * /api/verification/status/{studentId}:
 *   get:
 *     summary: Get student verification status
 *     tags: [Verification]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Student ID
 *         example: 123e4567-e89b-12d3-a456-426614174000
 *     responses:
 *       200:
 *         description: Verification status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: object
 *                           properties:
 *                             isVerified:
 *                               type: boolean
 *                             verificationStatus:
 *                               type: string
 *                               enum: [unverified, verified, expired]
 *                             lastVerificationDate:
 *                               type: string
 *                               format: date-time
 *                               nullable: true
 *                             verificationMethod:
 *                               type: string
 *                               enum: [portal, email, registration, whatsapp]
 *                               nullable: true
 *                             expiresAt:
 *                               type: string
 *                               format: date-time
 *                               nullable: true
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */
