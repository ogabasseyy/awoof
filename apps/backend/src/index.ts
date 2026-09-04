/**
 * Awoof Backend API
 * 
 * Main entry point for the application
 * Follows SOLID principles with clean architecture
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './config/env.js';
import { db } from './config/database.js';
import { redis } from './config/redis.js';
import { errorHandler } from './common/middleware/errorHandler.js';
import { logger } from './common/middleware/logger.js';
import { appLogger } from './common/logger.js';
import { swaggerSpec } from './config/swagger.js';

/**
 * Application class
 * Encapsulates Express app setup following Single Responsibility Principle
 */
class App {
  private app: Express;

  constructor() {
    this.app = express();
    this.initializeWebhookRoute();
    this.initializeMiddlewares();
    // Note: Error handling must be initialized AFTER routes
  }

  /**
   * Paystack webhook must receive raw body for HMAC verification.
   */
  private initializeWebhookRoute(): void {
    this.app.post(
      '/api/webhooks/paystack',
      express.raw({ type: 'application/json' }),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { handlePaystackWebhook } = await import('./controllers/webhook.controller.js');
          await handlePaystackWebhook(req, res);
        } catch (error) {
          next(error);
        }
      }
    );
  }

  /**
   * Initialize middleware
   */
  private initializeMiddlewares(): void {
    // Security headers (Helmet). API-only: use explicit CSP (CodeQL requires no contentSecurityPolicy: false).
    // Permissive CSP for JSON API; crossOriginEmbedder off for cross-origin frontend requests.
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: { defaultSrc: ["'self'"], scriptSrc: ["'none'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
      })
    );

    // CORS
    this.app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin) {
            callback(null, true);
            return;
          }

          const staticOrigins = new Set(config.cors.origin.map((value) => value.trim()));
          if (staticOrigins.has(origin)) {
            callback(null, true);
            return;
          }

          let parsed: URL;
          try {
            parsed = new URL(origin);
          } catch {
            callback(null, false);
            return;
          }

          const localDevelopment = config.isDevelopment
            && parsed.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
          if (parsed.protocol !== 'https:' && !localDevelopment) {
            callback(null, false);
            return;
          }

          db.query(
            `SELECT 1 FROM widget_configs
             WHERE status = 'active' AND $1 = ANY(allowed_domains)
             LIMIT 1`,
            [parsed.hostname.toLowerCase()]
          ).then((result) => callback(null, result.rows.length > 0))
            .catch((error) => {
              appLogger.error('Dynamic widget CORS lookup failed', error);
              callback(null, false);
            });
        },
        credentials: true,
      })
    );

    // Body parser
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Global rate limit (brute-force / DoS protection)
    this.app.use(
      rateLimit({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.maxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => {
          res.status(429).json({
            success: false,
            error: { message: 'Too many requests. Please try again later.', statusCode: 429 },
          });
        },
      })
    );

    // Request logger
    this.app.use(logger);

    // Health check (before authentication)
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    });

    // Swagger API documentation (development only; avoid exposing API surface in production)
    if (config.isDevelopment) {
      this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
        customCss: '.swagger-ui .topbar { display: none }',
        customSiteTitle: 'Awoof API Documentation',
      }));
    }

    // Static file serving for uploads
    this.app.use('/uploads', express.static('uploads'));
  }

  /**
   * Initialize routes
   */
  private async initializeRoutes(): Promise<void> {
    // Root route (minimal in production)
    this.app.get('/', (_req, res) => {
      res.json({
        message: 'Awoof Backend API',
        version: '1.0.0',
        ...(config.isDevelopment && {
          documentation: '/api-docs',
          endpoints: {
            auth: '/api/auth',
            students: '/api/students',
            universities: '/api/universities',
            verification: '/api/verification',
            vendors: '/api/vendors',
          },
        }),
      });
    });

    // Authentication routes (stricter rate limit: login, register, forgot-password abuse)
    try {
      const authRateLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 50, // 50 requests per window per IP
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => {
          res.status(429).json({
            success: false,
            error: { message: 'Too many auth attempts. Please try again later.', statusCode: 429 },
          });
        },
      });
      const authRoutes = await import('./routes/auth.routes.js');
      this.app.use('/api/auth', authRateLimiter, authRoutes.default);
      appLogger.info('Auth routes registered');
    } catch (error) {
      appLogger.error('Failed to register auth routes:', error);
      throw error;
    }

    try {
      const studentRoutes = await import('./routes/students.routes.js');
      this.app.use('/api/students', studentRoutes.default);
      appLogger.info('Student routes registered');
    } catch (error) {
      appLogger.error('Failed to register student routes:', error);
      throw error;
    }

    try {
      const universityRoutes = await import('./routes/universities.routes.js');
      this.app.use('/api/universities', universityRoutes.default);
      appLogger.info('University routes registered');
    } catch (error) {
      appLogger.error('Failed to register university routes:', error);
      throw error;
    }

    try {
      const verificationRoutes = await import('./routes/verification.routes.js');
      this.app.use('/api/verification', verificationRoutes.default);
      appLogger.info('Verification routes registered');
    } catch (error) {
      appLogger.error('Failed to register verification routes:', error);
      throw error;
    }

    try {
      const widgetRoutes = await import('./routes/widget.routes.js');
      this.app.use('/api/widget', widgetRoutes.default);
      appLogger.info('Widget routes registered');
    } catch (error) {
      appLogger.error('Failed to register widget routes:', error);
      throw error;
    }

    try {
      const vendorRoutes = await import('./routes/vendors.routes.js');
      this.app.use('/api/vendors', vendorRoutes.default);
      appLogger.info('Vendor routes registered');
    } catch (error) {
      appLogger.error('Failed to register vendor routes:', error);
      throw error;
    }

    try {
      const productsRoutes = await import('./routes/products.routes.js');
      this.app.use('/api/products', productsRoutes.default);
      appLogger.info('Products routes registered');
    } catch (error) {
      appLogger.error('Failed to register products routes:', error);
      throw error;
    }

    try {
      const checkoutRoutes = await import('./routes/checkout.routes.js');
      this.app.use('/api/checkout', checkoutRoutes.default);
      appLogger.info('Checkout routes registered');
    } catch (error) {
      appLogger.error('Failed to register checkout routes:', error);
      throw error;
    }

    try {
      const adminRoutes = await import('./routes/admin.routes.js');
      this.app.use('/api/admin', adminRoutes.default);
      appLogger.info('Admin routes registered');
    } catch (error) {
      appLogger.error('Failed to register admin routes:', error);
      throw error;
    }

    try {
      const supportRoutes = await import('./routes/support.routes.js');
      this.app.use('/api/support', supportRoutes.default);
      appLogger.info('Support routes registered');
    } catch (error) {
      appLogger.error('Failed to register support routes:', error);
      throw error;
    }
  }

  /**
   * Initialize error handling
   */
  private initializeErrorHandling(): void {
    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({
        success: false,
        error: {
          message: 'Route not found',
          code: 'NOT_FOUND',
          statusCode: 404,
        },
      });
    });

    // Error handler (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Start server
   */
  public async start(): Promise<void> {
    try {
      // Initialize database
      db.initialize();

      // Run database migrations
      if (process.env.RUN_MIGRATIONS !== 'false') {
        const { runMigrations } = await import('./database/migrations/run.js');
        await runMigrations();
      }

      // Initialize Redis
      redis.initialize();

      const { startCommerceNotificationDispatcher } = await import('./services/payment/checkout.service.js');
      startCommerceNotificationDispatcher();

      // Initialize routes (must be after database is ready)
      await this.initializeRoutes();

      // Initialize error handling (must be AFTER routes)
      this.initializeErrorHandling();

      // Start server
      this.app.listen(config.port, () => {
        appLogger.info(`Awoof Backend API listening on port ${config.port}`);
      });
    } catch (error) {
      appLogger.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    appLogger.info('Shutting down server...');

    try {
      await db.close();
      await redis.close();
      appLogger.info('Server shut down gracefully');
      process.exit(0);
    } catch (error) {
      appLogger.error('Error during shutdown:', error);
      process.exit(1);
    }
  }

  /**
   * Get Express app (for testing)
   */
  public getApp(): Express {
    return this.app;
  }
}

// Create app instance
const app = new App();

// Start server
app.start();

// Graceful shutdown handlers
process.on('SIGTERM', () => app.shutdown());
process.on('SIGINT', () => app.shutdown());

// Handle unhandled errors (always log)
process.on('unhandledRejection', (reason, promise) => {
  appLogger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  appLogger.error('Uncaught Exception:', error);
  process.exit(1);
});

export default app;
