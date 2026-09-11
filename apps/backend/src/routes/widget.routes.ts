/**
 * Widget Routes
 *
 * Public API for the embeddable student verification widget.
 * No authentication required; validation is via apiKey + domain allowlist.
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import * as widgetController from '../controllers/widget.controller.js';

const router = Router();

/**
 * @route   GET /api/widget/domain-check
 * @desc    Check if current domain is allowed for the given widget API key
 * @query   domain - hostname (e.g. vendor-site.com)
 * @query   apiKey - vendor widget API key
 * @access  Public
 */
router.get(
    '/domain-check',
    asyncHandler(widgetController.domainCheck)
);

export default router;
