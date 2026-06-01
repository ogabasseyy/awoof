/**
 * Vendor Routes
 * 
 * Handles vendor profile management and file uploads
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { VendorController } from '../controllers/vendor.controller.js';
import { ProductController } from '../controllers/product.controller.js';
import { OrderController } from '../controllers/order.controller.js';
import { PaymentController } from '../controllers/payment.controller.js';
import { AnalyticsController } from '../controllers/analytics.controller.js';
import { VendorSupportController } from '../controllers/vendor-support.controller.js';
import { getWidgetConfig, updateWidgetConfig } from '../controllers/widget-config.controller.js';
import { upload } from '../config/upload.js';

const router = Router();
const vendorController = new VendorController();
const productController = new ProductController();
const orderController = new OrderController();
const paymentController = new PaymentController();
const analyticsController = new AnalyticsController();
const vendorSupportController = new VendorSupportController();

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
 * @route   PUT /api/vendors/payment/payout-settings
 * @desc    Update payout settings
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
 */
router.post(
    '/transactions/report',
    authenticate, // TODO: Add API key authentication middleware
    asyncHandler(paymentController.reportTransaction.bind(paymentController))
);

/**
 * Analytics Routes
 */

/**
 * @route   GET /api/vendors/analytics
 * @desc    Get vendor analytics
 * @access  Private (Vendor)
 */
router.get(
    '/analytics',
    authenticate,
    asyncHandler(analyticsController.getAnalytics.bind(analyticsController))
);

/**
 * Support Ticket Routes
 */

/**
 * @route   POST /api/vendors/support-tickets
 * @desc    Create a new support ticket
 * @access  Private (Vendor)
 */
router.post(
    '/support-tickets',
    authenticate,
    asyncHandler(vendorSupportController.createTicket.bind(vendorSupportController))
);

/**
 * @route   GET /api/vendors/support-tickets
 * @desc    Get all support tickets for the vendor
 * @access  Private (Vendor)
 */
router.get(
    '/support-tickets',
    authenticate,
    asyncHandler(vendorSupportController.getTickets.bind(vendorSupportController))
);

/**
 * @route   GET /api/vendors/support-tickets/:id
 * @desc    Get a single support ticket with responses
 * @access  Private (Vendor)
 */
router.get(
    '/support-tickets/:id',
    authenticate,
    asyncHandler(vendorSupportController.getTicket.bind(vendorSupportController))
);

/**
 * @route   POST /api/vendors/support-tickets/:id/responses
 * @desc    Add a response to a support ticket
 * @access  Private (Vendor)
 */
router.post(
    '/support-tickets/:id/responses',
    authenticate,
    asyncHandler(vendorSupportController.addResponse.bind(vendorSupportController))
);

export default router;

