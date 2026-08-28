/**
 * Vendor Support Page
 * 
 * Allows vendors to create and manage support tickets
 */

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Headphones, Send, MessageCircle, Mail, Phone } from 'lucide-react';
import { BarChart3, Bell, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient from '@/lib/api-client';

const iconProps = { className: 'h-5 w-5', strokeWidth: 1.5, fill: 'currentColor' as const };

const primaryNavItems = [
    { id: 'dashboard', label: 'Dashboard', href: '/vendor/dashboard', icon: <LayoutDashboard {...iconProps} /> },
    { id: 'manage-deals', label: 'Manage Deals', href: '/vendor/deals', icon: <Tag {...iconProps} /> },
    { id: 'orders', label: 'Orders', href: '/vendor/orders', icon: <ShoppingBag {...iconProps} /> },
    { id: 'analytics', label: 'Analytics', href: '/vendor/analytics', icon: <BarChart3 {...iconProps} /> },
    { id: 'payment', label: 'Payment', href: '/vendor/payment', icon: <CreditCard {...iconProps} /> },
    { id: 'integration', label: 'Integration', href: '/vendor/integration', icon: <Puzzle {...iconProps} /> },
];

const secondaryNavItems = [
    { id: 'support', label: 'Support', href: '/vendor/support', icon: <LifeBuoy {...iconProps} /> },
    { id: 'notifications', label: 'Notifications', href: '/vendor/notifications', icon: <Bell {...iconProps} /> },
    { id: 'settings', label: 'Settings', href: '/vendor/settings', icon: <Settings {...iconProps} /> },
];

interface SupportTicket {
    id: string;
    subject: string;
    message: string;
    category: string;
    status: 'open' | 'in-progress' | 'resolved' | 'closed';
    createdAt: string;
    updatedAt: string;
}

export default function VendorSupportPage() {
    const { user, logout } = useAuth();
    const router = useRouter();
    const [showForm, setShowForm] = useState(false);
    const [formData, setFormData] = useState({
        subject: '',
        message: '',
        category: 'general',
    });
    const [tickets, setTickets] = useState<SupportTicket[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    type VendorProfile = { companyName?: string | null; name?: string | null };
    const extendedUser = user as (User & { profile?: VendorProfile }) | null;
    const companyName = extendedUser?.profile?.companyName ?? null;
    const displayName = companyName ?? extendedUser?.profile?.name ?? extendedUser?.email ?? 'Vendor';

    useEffect(() => {
        fetchTickets();
    }, []);

    const fetchTickets = async () => {
        try {
            setIsLoading(true);
            const response = await apiClient.get('/vendors/support-tickets');
            if (response?.data?.data?.tickets) {
                const formattedTickets: SupportTicket[] = response.data.data.tickets.map((ticket: {
                    id: string;
                    subject: string;
                    message: string;
                    category: string;
                    status: string;
                    createdAt?: string;
                    updatedAt?: string;
                    created_at?: string;
                    updated_at?: string;
                }) => ({
                    id: ticket.id,
                    subject: ticket.subject,
                    message: ticket.message,
                    category: ticket.category,
                    status: ticket.status as 'open' | 'in-progress' | 'resolved' | 'closed',
                    createdAt: ticket.createdAt || ticket.created_at || '',
                    updatedAt: ticket.updatedAt || ticket.updated_at || '',
                }));
                setTickets(formattedTickets);
            }
        } catch (err) {
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Failed to load support tickets');
        } finally {
            setIsLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setError(null);
        setSuccessMessage(null);

        try {
            const response = await apiClient.post('/vendors/support-tickets', formData);
            if (response?.data?.data?.ticket) {
                setFormData({ subject: '', message: '', category: 'general' });
                setShowForm(false);
                setSuccessMessage('Support ticket submitted successfully!');
                router.push(`/vendor/support/${response.data.data.ticket.id}`);
            }
        } catch (err) {
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Failed to submit ticket. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'open':
                return 'bg-blue-100 text-blue-800';
            case 'in-progress':
                return 'bg-yellow-100 text-yellow-800';
            case 'resolved':
                return 'bg-green-100 text-green-800';
            case 'closed':
                return 'bg-gray-100 text-gray-800';
            default:
                return 'bg-gray-100 text-gray-800';
        }
    };

    return (
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Support"
                onLogout={logout}
                logoutLabel="Log out"
                user={{
                    name: displayName,
                    email: user?.email ?? null,
                    roleLabel: 'Vendor',
                    secondaryText: companyName ?? undefined,
                    profileHref: '/vendor/settings',
                    avatarUrl: null,
                }}
            >
                <div className="space-y-6">
                    {/* Success/Error Messages */}
                    {successMessage && (
                        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg">
                            {successMessage}
                        </div>
                    )}
                    {error && (
                        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
                            {error}
                        </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Contact Options */}
                        <div className="lg:col-span-1">
                            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6 sticky top-4">
                                <h2 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
                                    <Headphones className="h-5 w-5" />
                                    Get in Touch
                                </h2>
                                <div className="space-y-4">
                                    <a
                                        href="mailto:support@awoof.tech"
                                        className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                                    >
                                        <Mail className="h-5 w-5 text-slate-600" />
                                        <div>
                                            <p className="text-sm font-medium text-slate-900">Email</p>
                                            <p className="text-xs text-slate-600">support@awoof.tech</p>
                                        </div>
                                    </a>
                                    <a
                                        href="tel:+2348000000000"
                                        className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                                    >
                                        <Phone className="h-5 w-5 text-slate-600" />
                                        <div>
                                            <p className="text-sm font-medium text-slate-900">Phone</p>
                                            <p className="text-xs text-slate-600">+234 800 000 0000</p>
                                        </div>
                                    </a>
                                </div>
                            </div>
                        </div>

                        {/* Main Content */}
                        <div className="lg:col-span-2 space-y-6">
                            {!showForm ? (
                                <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                                    <h2 className="font-semibold text-slate-900 mb-4">Submit a Support Ticket</h2>
                                    <p className="text-slate-600 mb-4">
                                        Have a question or need help? Submit a ticket and our support team will get back to you.
                                    </p>
                                    <Button onClick={() => setShowForm(true)} style={{ backgroundColor: '#1D4ED8' }}>
                                        <MessageCircle className="h-4 w-4 mr-2" />
                                        Submit a Ticket
                                    </Button>
                                </div>
                            ) : (
                                <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                                    <h2 className="font-semibold text-slate-900 mb-4">Submit Support Ticket</h2>
                                    <form onSubmit={handleSubmit} className="space-y-4">
                                        <div>
                                            <Label htmlFor="category">Category</Label>
                                            <select
                                                id="category"
                                                value={formData.category}
                                                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                                                className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D4ED8]"
                                            >
                                                <option value="general">General Inquiry</option>
                                                <option value="technical">Technical Issue</option>
                                                <option value="billing">Billing Question</option>
                                                <option value="account">Account Issue</option>
                                                <option value="integration">Integration Help</option>
                                                <option value="product">Product Management</option>
                                            </select>
                                        </div>
                                        <div>
                                            <Label htmlFor="subject">Subject</Label>
                                            <Input
                                                id="subject"
                                                value={formData.subject}
                                                onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                                                placeholder="Brief description of your issue"
                                                required
                                            />
                                        </div>
                                        <div>
                                            <Label htmlFor="message">Message</Label>
                                            <Textarea
                                                id="message"
                                                value={formData.message}
                                                onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                                                placeholder="Please provide details about your issue..."
                                                rows={6}
                                                required
                                            />
                                        </div>
                                        <div className="flex gap-3">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={() => {
                                                    setShowForm(false);
                                                    setFormData({ subject: '', message: '', category: 'general' });
                                                    setError(null);
                                                }}
                                            >
                                                Cancel
                                            </Button>
                                            <Button
                                                type="submit"
                                                disabled={isSubmitting}
                                                style={{ backgroundColor: '#1D4ED8' }}
                                            >
                                                <Send className="h-4 w-4 mr-2" />
                                                {isSubmitting ? 'Submitting...' : 'Submit Ticket'}
                                            </Button>
                                        </div>
                                    </form>
                                </div>
                            )}

                            {/* Tickets List */}
                            {isLoading ? (
                                <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                                    <p className="text-slate-500">Loading tickets...</p>
                                </div>
                            ) : tickets.length > 0 ? (
                                <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                                    <h2 className="font-semibold text-slate-900 mb-4">Your Support Tickets</h2>
                                    <div className="space-y-4">
                                        {tickets.map((ticket) => (
                                            <Link
                                                key={ticket.id}
                                                href={`/vendor/support/${ticket.id}`}
                                                className="block p-4 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                                            >
                                                <div className="flex items-start justify-between mb-2">
                                                    <div className="flex-1">
                                                        <h3 className="font-semibold text-slate-900">{ticket.subject}</h3>
                                                        <p className="text-xs text-slate-500 mt-1">Category: {ticket.category}</p>
                                                    </div>
                                                    <span className={`text-xs font-medium px-2 py-1 rounded ${getStatusColor(ticket.status)}`}>
                                                        {ticket.status}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-slate-500">Created: {formatDate(ticket.createdAt)}</p>
                                            </Link>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                                    <p className="text-slate-500 text-center py-8">No support tickets yet. Submit a ticket to get started.</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
