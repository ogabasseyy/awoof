/**
 * Swagger documentation for Student Routes
 * 
 * This file contains OpenAPI/Swagger annotations for student endpoints
 */

/**
 * @swagger
 * tags:
 *   - name: Students
 *     description: Student profile and data management endpoints
 */

/**
 * @swagger
 * /api/students/profile:
 *   get:
 *     summary: Get current student profile
 *     tags: [Students]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Student profile retrieved successfully
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
 *                         user:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: string
 *                               format: uuid
 *                             email:
 *                               type: string
 *                             role:
 *                               type: string
 *                             verificationStatus:
 *                               type: string
 *                             createdAt:
 *                               type: string
 *                               format: date-time
 *                             profile:
 *                               $ref: '#/components/schemas/StudentProfile'
 *                               nullable: true
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/students/profile:
 *   put:
 *     summary: Update student profile
 *     tags: [Students]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 example: John Doe
 *               university:
 *                 type: string
 *                 example: University of Lagos
 *               registrationNumber:
 *                 type: string
 *                 example: '2019/12345'
 *               phoneNumber:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *                 example: '+2348012345678'
 *     responses:
 *       200:
 *         description: Profile updated successfully
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
 *                         user:
 *                           type: object
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/students/purchases:
 *   get:
 *     summary: Get student purchase history
 *     tags: [Students]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Purchase history retrieved successfully
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
 *                         transactions:
 *                           type: array
 *                           items:
 *                             type: object
 *                         pagination:
 *                           type: object
 *                           properties:
 *                             page:
 *                               type: integer
 *                             limit:
 *                               type: integer
 *                             total:
 *                               type: integer
 *                             totalPages:
 *                               type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/students/savings:
 *   get:
 *     summary: Get student savings statistics
 *     tags: [Students]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Savings statistics retrieved successfully
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
 *                         summary:
 *                           type: object
 *                           properties:
 *                             totalPurchases:
 *                               type: integer
 *                             totalSavings:
 *                               type: number
 *                               nullable: true
 *                               description: Complete recorded savings, or null when any completed purchase has an unknown historical credit.
 *                             recordedSavings:
 *                               type: number
 *                               description: Subtotal of known recorded credits; may be partial when unknownSavingsCount is positive.
 *                             unknownSavingsCount:
 *                               type: integer
 *                               minimum: 0
 *                               description: Number of completed purchases without a recorded savings credit.
 *                             totalSpent:
 *                               type: number
 *                             totalValue:
 *                               type: number
 *                               nullable: true
 *                               description: Total paid plus recorded savings, or null when historical savings are incomplete.
 *                         byCategory:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               categoryName:
 *                                 type: string
 *                               purchaseCount:
 *                                 type: integer
 *                               savings:
 *                                 type: number
 *                                 nullable: true
 *                                 description: Complete category savings, or null when any included credit is unknown.
 *                               recordedSavings:
 *                                 type: number
 *                                 description: Subtotal of known recorded credits for this category.
 *                               unknownSavingsCount:
 *                                 type: integer
 *                                 minimum: 0
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
