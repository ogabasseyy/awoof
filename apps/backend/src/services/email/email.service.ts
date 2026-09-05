/**
 * Email Service
 * 
 * Handles email sending using Brevo (formerly Sendinblue)
 * Follows Single Responsibility Principle - only handles email operations
 */

// @ts-ignore - sib-api-v3-sdk doesn't have TypeScript definitions
import SibApiV3Sdk from 'sib-api-v3-sdk';
import { appLogger } from '../../common/logger.js';

/**
 * Configure Brevo API client
 */
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];

if (!process.env.BREVO_API_KEY) {
    appLogger.warn('BREVO_API_KEY is not defined. Email functionality will be limited.');
} else {
    apiKey.apiKey = process.env.BREVO_API_KEY;
}

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * Send email with retry logic
 */
export const sendEmail = async (
    to: string,
    subject: string,
    html: string,
    retries: number = 3
): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    if (!process.env.BREVO_API_KEY) {
        appLogger.error('BREVO_API_KEY is not configured');
        return { success: false, error: 'Email service not configured' };
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

            sendSmtpEmail.subject = subject;
            sendSmtpEmail.htmlContent = html;
            sendSmtpEmail.sender = {
                name: process.env.BREVO_FROM_NAME || 'Awoof',
                email: process.env.EMAIL_FROM || 'noreply@awoof.com',
            };
            sendSmtpEmail.to = [{ email: to }];

            const result = await apiInstance.sendTransacEmail(sendSmtpEmail);
            return { success: true, messageId: result.messageId };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            appLogger.error(`Email sending failed (attempt ${attempt}/${retries}):`, message);

            if (attempt === retries) {
                return { success: false, error: message };
            }

            const delay = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    return { success: false, error: 'Max retries exceeded' };
};

/**
 * Send OTP email for password reset
 */
export const sendPasswordResetOTP = async (
    email: string,
    otp: string
): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    const subject = 'Reset your Awoof password';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center;">
                <h1 style="color: #FFFFFF; margin: 0;">Awoof</h1>
            </div>
            <div style="padding: 30px; background-color: #f9f9f9;">
                <h2 style="color: #1D4ED8;">Reset Your Password</h2>
                <p>You requested to reset your password. Please use the OTP code below:</p>
                <div style="background-color: #1D4ED8; color: #FFFFFF; padding: 20px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 5px;">
                    ${otp}
                </div>
                <p>This code will expire in 10 minutes.</p>
                <p>If you didn't request a password reset, please ignore this email.</p>
            </div>
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center; color: #FFFFFF;">
                <p style="margin: 0;">© 2025 Awoof. All rights reserved.</p>
            </div>
        </div>
    `;

    return await sendEmail(email, subject, html);
};

/**
 * Send email verification OTP for vendor and student registration
 */
export const sendEmailVerificationOTP = async (
    email: string,
    otp: string,
    name?: string,
    role: 'vendor' | 'student' = 'vendor'
): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    const isStudent = role === 'student';
    const subject = isStudent
        ? 'Verify your email - Awoof Student Registration'
        : 'Verify your email - Awoof Vendor Registration';

    const greeting = name ? `Hello ${name},` : 'Hello,';
    const registrationText = isStudent
        ? 'Thank you for registering as a student on Awoof.'
        : 'Thank you for registering as a vendor on Awoof.';

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center;">
                <h1 style="color: #FFFFFF; margin: 0;">Awoof</h1>
            </div>
            <div style="padding: 30px; background-color: #f9f9f9;">
                <h2 style="color: #1D4ED8;">Verify Your Email Address</h2>
                <p>${greeting}</p>
                <p>${registrationText} Please verify your email address using the OTP code below:</p>
                <div style="background-color: #1D4ED8; color: #FFFFFF; padding: 20px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 5px;">
                    ${otp}
                </div>
                <p>This code will expire in 10 minutes.</p>
                <p>If you didn't create an account with Awoof, please ignore this email.</p>
            </div>
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center; color: #FFFFFF;">
                <p style="margin: 0;">© 2025 Awoof. All rights reserved.</p>
            </div>
        </div>
    `;

    return await sendEmail(email, subject, html);
};

/**
 * Send welcome email after successful student registration
 */
export const sendWelcomeEmail = async (
    email: string,
    name?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    const greeting = name ? `Hello ${name},` : 'Hello,';
    const subject = 'Welcome to Awoof!';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center;">
                <h1 style="color: #FFFFFF; margin: 0;">Awoof</h1>
            </div>
            <div style="padding: 30px; background-color: #f9f9f9;">
                <h2 style="color: #1D4ED8;">Welcome to Awoof!</h2>
                <p>${greeting}</p>
                <p>Your student account has been created successfully. You can now access exclusive discounts on food, tech, and travel.</p>
                <p><a href="${frontendUrl}/marketplace" style="background-color: #1D4ED8; color: #FFFFFF; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">Explore Marketplace</a></p>
                <p>If you have any questions, feel free to reach out to our support team.</p>
            </div>
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center; color: #FFFFFF;">
                <p style="margin: 0;">© 2025 Awoof. All rights reserved.</p>
            </div>
        </div>
    `;

    return await sendEmail(email, subject, html);
};


function supportShell(title: string, bodyHtml: string): string {
    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center;">
                <h1 style="color: #FFFFFF; margin: 0;">Awoof</h1>
            </div>
            <div style="padding: 30px; background-color: #f9f9f9;">
                <h2 style="color: #1D4ED8;">${title}</h2>
                ${bodyHtml}
            </div>
            <div style="background-color: #1D4ED8; padding: 20px; text-align: center; color: #FFFFFF;">
                <p style="margin: 0;">© Awoof. All rights reserved.</p>
            </div>
        </div>
    `;
}

function ticketLink(ticketId: string, role: string): string {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    if (role === 'admin') return `${base}/admin/support/${ticketId}`;
    if (role === 'vendor') return `${base}/vendor/support/${ticketId}`;
    return `${base}/student/profile/support/${ticketId}`;
}

export const sendSupportTicketCreatedEmail = async (
    email: string,
    subject: string,
    requesterRole: string,
    ticketId: string
) => {
    const html = supportShell(
        'New support ticket',
        `<p>A new <strong>${escapeHtml(requesterRole)}</strong> ticket was opened.</p>
         <p><strong>${escapeHtml(subject)}</strong></p>
         <p><a href="${ticketLink(ticketId, 'admin')}" style="color:#1D4ED8;">Open in admin</a></p>`
    );
    return sendEmail(email, `[Support] ${subject}`, html);
};

export const sendSupportTicketReplyEmail = async (
    email: string,
    ticketSubject: string,
    replyPreview: string,
    ticketId: string,
    viewerRole: string
) => {
    const preview = replyPreview.length > 280 ? `${replyPreview.slice(0, 280)}…` : replyPreview;
    const html = supportShell(
        'New reply on your ticket',
        `<p>Ticket: <strong>${escapeHtml(ticketSubject)}</strong></p>
         <p style="white-space:pre-wrap;">${escapeHtml(preview)}</p>
         <p><a href="${ticketLink(ticketId, viewerRole)}" style="color:#1D4ED8;">View conversation</a></p>`
    );
    return sendEmail(email, `Re: ${ticketSubject}`, html);
};

export const sendSupportTicketStatusEmail = async (
    email: string,
    ticketSubject: string,
    status: string,
    ticketId: string,
    viewerRole: string
) => {
    const html = supportShell(
        'Ticket status updated',
        `<p>Your ticket <strong>${escapeHtml(ticketSubject)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>
         <p><a href="${ticketLink(ticketId, viewerRole)}" style="color:#1D4ED8;">View ticket</a></p>`
    );
    return sendEmail(email, `Ticket ${status}: ${ticketSubject}`, html);
};

export const sendPurchaseConfirmationEmail = async (
    email: string,
    productName: string,
    amount: number,
    transactionId: string
) => {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const html = supportShell(
        'Purchase confirmed',
        `<p>Your purchase of <strong>${escapeHtml(productName)}</strong> for <strong>₦${amount.toLocaleString()}</strong> is confirmed.</p>
         <p>Reference: ${transactionId}</p>
         <p><a href="${base}/student/profile/receipts" style="color:#1D4ED8;">View receipts</a></p>`
    );
    return sendEmail(email, `Receipt: ${productName}`, html);
};

export const sendVendorNewOrderEmail = async (
    email: string,
    productName: string,
    amount: number,
    transactionId: string
) => {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const html = supportShell(
        'New marketplace order',
        `<p>You received an order for <strong>${escapeHtml(productName)}</strong> (₦${amount.toLocaleString()}).</p>
         <p>Reference: ${transactionId}</p>
         <p><a href="${base}/vendor/orders" style="color:#1D4ED8;">View orders</a></p>`
    );
    return sendEmail(email, `New order: ${productName}`, html);
};
