/**
 * Swagger documentation for University Routes
 */

/**
 * @swagger
 * tags:
 *   - name: Universities
 *     description: University listing and verification methods endpoints
 */

/**
 * @swagger
 * /api/universities:
 *   get:
 *     summary: List all active universities
 *     tags: [Universities]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: country
 *         schema:
 *           type: string
 *         description: Filter by country
 *         example: Nigeria
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by university name or domain
 *         example: Lagos
 *     responses:
 *       200:
 *         description: Universities retrieved successfully
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
 *                         universities:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                                 format: uuid
 *                               name:
 *                                 type: string
 *                                 example: University of Lagos
 *                               domain:
 *                                 type: string
 *                                 example: unilag.edu.ng
 *                               country:
 *                                 type: string
 *                                 example: Nigeria
 *                               portalUrl:
 *                                 type: string
 *                                 nullable: true
 *                               databaseApiUrl:
 *                                 type: string
 *                                 nullable: true
 *                               isActive:
 *                                 type: boolean
 *                               createdAt:
 *                                 type: string
 *                                 format: date-time
 *                         total:
 *                           type: integer
 */

/**
 * @swagger
 * /api/universities/{id}/verification-methods:
 *   get:
 *     summary: Retired verification methods endpoint
 *     deprecated: true
 *     description: Use /api/verification/methods/{universityId} for sanitized availability.
 *     tags: [Universities]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       410:
 *         description: Verification route retired
 */
