/**
 * Database Configuration
 * 
 * PostgreSQL connection setup using pg library
 * Follows Dependency Inversion Principle - uses interface for database connection
 */

import pg from 'pg';
import { config } from './env.js';

const { Pool } = pg;

/**
 * Database connection pool
 * Singleton pattern ensures single pool instance
 */
class Database {
    private pool: pg.Pool | null = null;
    private static instance: Database;

    private constructor() {
        // Private constructor for singleton
    }

    /**
     * Get database instance (Singleton)
     */
    public static getInstance(): Database {
        if (!Database.instance) {
            Database.instance = new Database();
        }
        return Database.instance;
    }

    /**
     * Initialize database connection pool
     */
    public initialize(): pg.Pool {
        if (this.pool) {
            return this.pool;
        }

        const connectionConfig: pg.PoolConfig = {
            host: config.database.host,
            port: config.database.port,
            database: config.database.name,
            user: config.database.user,
            password: config.database.password,
            max: 20, // Maximum number of clients in the pool
            idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
            connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
        };

        // Use connection string if provided
        if (config.database.url) {
            this.pool = new Pool({
                connectionString: config.database.url,
                max: connectionConfig.max,
                idleTimeoutMillis: connectionConfig.idleTimeoutMillis,
                connectionTimeoutMillis: connectionConfig.connectionTimeoutMillis,
            });
        } else {
            this.pool = new Pool(connectionConfig);
        }

        // Handle pool errors
        this.pool.on('error', (err) => {
            console.error('❌ Unexpected database pool error:', err);
            process.exit(-1);
        });

        // Test connection
        this.pool.query('SELECT NOW()', (err) => {
            if (err) {
                console.error('❌ Database connection failed:', err);
                process.exit(-1);
            }
            console.log('✅ Database connected successfully');
        });

        return this.pool;
    }

    /**
     * Get database pool
     */
    public getPool(): pg.Pool {
        if (!this.pool) {
            return this.initialize();
        }
        return this.pool;
    }

    /**
     * Close database connection
     */
    public async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            console.log('✅ Database connection closed');
        }
    }

    /**
     * Execute a query
     * Provides a clean interface for database operations
     */
    public async query<T extends pg.QueryResultRow = any>(
        text: string,
        params?: any[]
    ): Promise<pg.QueryResult<T>> {
        const pool = this.getPool();
        const start = Date.now();

        try {
            const result = await pool.query<T>(text, params);
            const duration = Date.now() - start;

            if (config.isDevelopment) {
                console.log('📊 Query executed:', { text, duration: `${duration}ms`, rows: result.rowCount });
            }

            return result;
        } catch (error) {
            const duration = Date.now() - start;
            console.error('❌ Query error:', { text, duration: `${duration}ms`, error });
            throw error;
        }
    }
}

export const db = Database.getInstance();

// Export pool for direct access if needed
export const getPool = () => db.getPool();
