/**
 * Vendor Routes
 * 
 * Handles vendor profile management and file uploads
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, authenticateVendorJwtOrApiKey } from '../middleware/auth.middleware.js';
import { VendorController } from '../controllers/vendor.controller.js';
import { ProductController } from '../controllers/product.controller.js';
import { OrderController } from '../controllers/order.controller.js';
import { PaymentController } from '../controllers/payment.controller.js';
import { AnalyticsController } from '../controllers/analytics.controller.js';
import { ticketController } from '../controllers/ticket.controller.js';
import { getWidgetConfig, updateWidgetConfig } from '../controllers/widget-config.controller.js';
import { upload } from '../config/upload.js';

const router = Router();
const vendorController = new VendorController();
const productController = new ProductController();
const orderController = new OrderController();
const paymentController = new PaymentController();
const analyticsController = new AnalyticsController();

/**
 * @route   POST /api/vendors/upload
 * @desc    Upload vendor files (documents, logo, banner)
 * @access  Private (Vendor)
 */
router.post(
    '/upload',
    authenticate,
    upload.fields([
        { name: 'documentFront', maxCount: 1 },
        { name: 'documentBack', maxCount: 1 },
        { name: 'logoImage', maxCount: 1 },
        { name: 'bannerImage', maxCount: 1 },
    ]),
    asyncHandler(vendorController.uploadFiles.bind(vendorController))
);

/**
 * @route   POST /api/vendors/complete-registration
 * @desc    Complete vendor registration with company details
 * @access  Private (Vendor)
 */
router.post(
    '/complete-registration',
    authenticate,
    asyncHandler(vendorController.completeRegistration.bind(vendorController))
);

/**
 * @route   GET /api/vendors/profile
 * @desc    Get vendor profile
 * @access  Private (Vendor)
 */
router.get(
    '/profile',
    authenticate,
    asyncHandler(vendorController.getProfile.bind(vendorController))
);

/**
 * @route   PUT /api/vendors/profile
 * @desc    Update vendor profile
 * @access  Private (Vendor)
 */
router.put(
    '/profile',
    authenticate,
    asyncHandler(vendorController.updateProfile.bind(vendorController))
);

/**
 * Product Management Routes
 */

/**
 * @route   GET /api/vendors/products
 * @desc    Get all products for the vendor
 * @access  Private (Vendor)
 */
router.get(
    '/products',
    authenticate,
    asyncHandler(productController.getProducts.bind(productController))
);

/**
 * @route   GET /api/vendors/products/:id
 * @desc    Get a single product by ID
 * @access  Private (Vendor)
 */
router.get(
    '/products/:id',
    authenticate,
    asyncHandler(productController.getProduct.bind(productController))
);

/**
 * @route   POST /api/vendors/products
 * @desc    Create a new product
 * @access  Private (Vendor)
 */
router.post(
    '/products',
    authenticate,
    upload.single('productImage'),
    asyncHandler(productController.createProduct.bind(productController))
);

/**
 * @route   PUT /api/vendors/products/:id
 * @desc    Update a product
 * @access  Private (Vendor)
 */
router.put(
    '/products/:id',
    authenticate,
    upload.single('productImage'),
    asyncHandler(productController.updateProduct.bind(productController))
);

/**
 * @route   DELETE /api/vendors/products/:id
 * @desc    Delete a product (soft delete)
 * @access  Private (Vendor)
 */
router.delete(
    '/products/:id',
    authenticate,
    asyncHandler(productController.deleteProduct.bind(productController))
);

/**
 * @route   POST /api/vendors/products/sync
 * @desc    Trigger product sync from vendor API
 * @access  Private (Vendor)
 */
router.post(
    '/products/sync',
    authenticate,
    asyncHandler(productController.syncProducts.bind(productController))
);

/**
 * @route   GET /api/vendors/orders
 * @desc    Get all orders for the vendor
 * @access  Private (Vendor)
 */
router.get(
    '/orders',
    authenticate,
    asyncHandler(orderController.getOrders.bind(orderController))
);

/**
 * @route   GET /api/vendors/orders/:id
 * @desc    Get a single order by ID
 * @access  Private (Vendor)
 */
router.get(
    '/orders/:id',
    authenticate,
    asyncHandler(orderController.getOrder.bind(orderController))
);

/**
 * @route   PUT /api/vendors/orders/:id/status
 * @desc    Update order status
 * @access  Private (Vendor)
 */
router.put(
    '/orders/:id/status',
    authenticate,
    asyncHandler(orderController.updateOrderStatus.bind(orderController))
);

/**
 * @route   GET /api/vendors/payment/settings
 * @desc    Get payment settings and summary
 * @access  Private (Vendor)
 */
router.get(
    '/payment/settings',
    authenticate,
    asyncHandler(paymentController.getPaymentSettings.bind(paymentController))
);

/**
 * @route   GET /api/vendors/payment/banks
 * @desc    List Nigerian banks (Paystack)
 * @access  Private (Vendor)
 */
router.get(
    '/payment/banks',
    authenticate,
    asyncHandler(paymentController.listBanks.bind(paymentController))
);

/**
 * @route   POST /api/vendors/payment/resolve-account
 * @desc    Resolve bank account name (Paystack)
 * @access  Private (Vendor)
 */
router.post(
    '/payment/resolve-account',
    authenticate,
    asyncHandler(paymentController.resolveAccount.bind(paymentController))
);

/**
 * @route   PUT /api/vendors/payment/payout-settings
 * @desc    Update payout settings (creates/updates Paystack subaccount)
 * @access  Private (Vendor)
 */
router.put(
    '/payment/payout-settings',
    authenticate,
    asyncHandler(paymentController.updatePayoutSettings.bind(paymentController))
);

/**
 * @route   GET /api/vendors/payment/history
 * @desc    Get payment history
 * @access  Private (Vendor)
 */
router.get(
    '/payment/history',
    authenticate,
    asyncHandler(paymentController.getPaymentHistory.bind(paymentController))
);

/**
 * @route   GET /api/vendors/payment/commission-summary
 * @desc    Get commission summary
 * @access  Private (Vendor)
 */
router.get(
    '/payment/commission-summary',
    authenticate,
    asyncHandler(paymentController.getCommissionSummary.bind(paymentController))
);

/**
 * @route   PUT /api/vendors/payment/integration
 * @desc    Update payment method
 * @access  Private (Vendor)
 */
router.put(
    '/payment/integration',
    authenticate,
    asyncHandler(paymentController.updatePaymentMethod.bind(paymentController))
);

/**
 * @route   PUT /api/vendors/payment/paystack-subaccount
 * @desc    Update Paystack subaccount code
 * @access  Private (Vendor)
 */
router.put(
    '/payment/paystack-subaccount',
    authenticate,
    asyncHandler(paymentController.updatePaystackSubaccount.bind(paymentController))
);

/**
 * @route   POST /api/vendors/payment/api-key
 * @desc    Generate API key for transaction reporting
 * @access  Private (Vendor)
 */
router.post(
    '/payment/api-key',
    authenticate,
    asyncHandler(paymentController.generateApiKey.bind(paymentController))
);

/**
 * @route   GET /api/vendors/payment/api-key
 * @desc    Get vendor API key info
 * @access  Private (Vendor)
 */
router.get(
    '/payment/api-key',
    authenticate,
    asyncHandler(paymentController.getApiKey.bind(paymentController))
);

/**
 * @route   GET /api/vendors/widget-config
 * @desc    Get widget config (allowed domains, API key)
 * @access  Private (Vendor)
 */
router.get(
    '/widget-config',
    authenticate,
    asyncHandler(getWidgetConfig)
);

/**
 * @route   PUT /api/vendors/widget-config
 * @desc    Update widget config (allowed domains; optional regenerate API key)
 * @access  Private (Vendor)
 */
router.put(
    '/widget-config',
    authenticate,
    asyncHandler(updateWidgetConfig)
);

/**
 * @route   POST /api/vendors/transactions/report
 * @desc    Report transaction (for vendor website payments)
 * @access  Private (Vendor API Key or JWT)
 *
 * @swagger
 * /api/vendors/transactions/report:
 *   post:
 *     summary: Report a discounted transaction against a benefit authorization
 *     description: >
 *       Server-to-server only with a vendor JWT or a private awoof_ reporting key.
 *       Settles one discounted transaction against a product-bound benefit authorization
 *       minted by exchanging a merchant assertion. First use rechecks current enrollment
 *       authority, product binding, disclosure, quoted price and authorization expiry;
 *       legacy verification tokens are retired and fail closed. Exact committed retries
 *       return the original result without new benefit; changed bindings conflict.
 *       Late or expired first reports fail with reconciliation details instead of
 *       settling, and never mint a new authorization. A payment report alone cannot
 *       enforce an external checkout: the merchant must hold current enrollment
 *       authority before granting a discount.
 *     tags: [Vendors]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [benefitAuthorizationId, paymentReference, amount, productId, paymentGateway]
 *             properties:
 *               benefitAuthorizationId:
 *                 type: string
 *                 format: uuid
 *                 description: Product-bound authorization from a merchant-assertion exchange receipt.
 *               paymentReference:
 *                 type: string
 *                 minLength: 1
 *                 description: Payment reference from the merchant payment gateway.
 *               amount:
 *                 type: integer
 *                 minimum: 1
 *                 description: Charged amount in kobo (NGN minor units). Must exactly match the quoted student price.
 *               productId:
 *                 type: string
 *                 format: uuid
 *                 description: UUID of the purchased product. Must match the authorization binding.
 *               paymentGateway:
 *                 type: string
 *                 minLength: 1
 *                 description: Payment gateway used ('paystack' is verified externally; other values are merchant-attested).
 *     responses:
 *       '201':
 *         description: Discounted transaction settled.
 *       '200':
 *         description: Exact committed retry; the original result without new benefit.
 *       '400': { description: Invalid input, retired token, or amount/product/currency mismatch }
 *       '401': { description: Vendor JWT or reporting key invalid, or merchant inactive }
 *       '403': { description: Current enrollment authority or merchant disclosure unavailable }
 *       '404': { description: Unknown benefit authorization for this merchant }
 *       '409': { description: Conflicting report bindings, or a late first report needing explicit reconciliation }
 *       '422': { description: Request body failed strict validation }
 */
router.post(
    '/transactions/report',
    authenticateVendorJwtOrApiKey,
    asyncHandler(paymentController.reportTransaction.bind(paymentController))
);

/**
 * Analytics Routes
 */

/**
 * @route   GET /api/vendors/analytics
 * @desc    Get vendor analytics
 * @access  Private (Vendor)
 *
 * @swagger
 * components:
 *   schemas:
 *     VendorStudentAnalytics:
 *       type: object
 *       required: [totalStudents, purchasingStudents, repeatCustomers]
 *       properties:
 *         totalStudents: { type: integer, example: 11 }
 *         purchasingStudents:
 *           type: integer
 *           example: 7
 *           description: Students with a completed order at this vendor. Transaction-derived; never a count of current student verification.
 *         verifiedStudents:
 *           type: integer
 *           example: 7
 *           deprecated: true
 *           description: Deprecated alias of purchasingStudents. It never measured verification; use purchasingStudents.
 *         repeatCustomers: { type: integer, example: 3 }
 * /api/vendors/analytics:
 *   get:
 *     summary: Get vendor analytics
 *     description: Vendor-scoped orders, revenue, and student counts. Student counts are transaction-derived and never assert current enrollment.
 *     tags: [Vendors]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200':
 *         description: Analytics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 students: { $ref: '#/components/schemas/VendorStudentAnalytics' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 */
router.get(
    '/analytics',
    authenticate,
    asyncHandler(analyticsController.getAnalytics.bind(analyticsController))
);

/**
 * Support Ticket Routes (unified tickets)
 */
router.post(
    '/support-tickets',
    authenticate,
    asyncHandler(ticketController.create.bind(ticketController))
);

router.get(
    '/support-tickets',
    authenticate,
    asyncHandler(ticketController.listOwn.bind(ticketController))
);

router.get(
    '/support-tickets/:id',
    authenticate,
    asyncHandler(ticketController.getOwn.bind(ticketController))
);

router.post(
    '/support-tickets/:id/responses',
    authenticate,
    asyncHandler(ticketController.replyOwn.bind(ticketController))
);

router.post(
    '/support-tickets/:id/messages',
    authenticate,
    asyncHandler(ticketController.replyOwn.bind(ticketController))
);

export default router;

