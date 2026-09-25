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
 * @route   POST /api/widget/domain-check
 * @desc    Check if current domain is allowed for the given widget API key
 * @body    domain - hostname (e.g. vendor-site.com)
 * @body    origin - exact site origin, required by the pilot widget
 * @body    apiKey - vendor widget API key (never in the URL query string)
 * @access  Public
 */
router.post(
    '/domain-check',
    asyncHandler(widgetController.domainCheck)
);
router.post('/merchant-context', asyncHandler(widgetController.merchantContext));

export default router;
