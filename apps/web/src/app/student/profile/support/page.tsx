/**
 * Customer Support Page
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Headphones, ChevronLeft, Send, MessageCircle, Mail, Phone } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import apiClient from '@/lib/api-client';
import toast from 'react-hot-toast';

interface SupportTicket {
    id: string;
    subject: string;
    status: 'open' | 'in-progress' | 'resolved' | 'closed';
    createdAt: string;
    updatedAt: string;
}

export default function CustomerSupportPage() {
    const { } = useAuth();
    const router = useRouter();
    const [showForm, setShowForm] = useState(false);
    const [formData, setFormData] = useState({
        subject: '',
        message: '',
        category: 'general',
    });
    const [tickets, setTickets] = useState<SupportTicket[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        fetchTickets();
    }, []);

    const fetchTickets = async () => {
        try {
            const response = await apiClient.get('/students/support-tickets');
            if (response?.data?.data?.tickets) {
                const formattedTickets: SupportTicket[] = response.data.data.tickets.map((ticket: {
                    id: string;
                    subject: string;
                    status: string;
                    createdAt: string;
                    updatedAt: string;
                }) => ({
                    id: ticket.id,
                    subject: ticket.subject,
                    status: ticket.status as 'open' | 'in-progress' | 'resolved' | 'closed',
                    createdAt: ticket.createdAt,
                    updatedAt: ticket.updatedAt,
                }));
                setTickets(formattedTickets);
            }
        } catch (error) {
            console.error('Error fetching tickets:', error);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        try {
            const response = await apiClient.post('/students/support-tickets', formData);
            if (response?.data?.data?.ticket) {
                toast.success('Support ticket submitted successfully');
                router.push(`/student/profile/support/${response.data.data.ticket.id}`);
            }
        } catch (error) {
            console.error('Error submitting ticket:', error);
            toast.error('Failed to submit ticket. Please try again.');
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
        <ProtectedRoute requiredRole="student">
            <div className="min-h-screen bg-gray-50">
                {/* Mobile View */}
                <div className="block md:hidden">
                    <div className="bg-white sticky top-0 z-10 border-b border-gray-200">
                        <div className="flex items-center gap-4 px-4 py-4">
                            <Link href="/student/profile">
                                <ChevronLeft className="h-6 w-6 text-gray-600" />
                            </Link>
                            <div className="flex items-center gap-2">
                                <Headphones className="h-5 w-5 text-gray-600" />
                                <h1 className="text-lg font-semibold text-gray-900">Customer Support</h1>
                            </div>
                        </div>
                    </div>

                    <div className="px-4 py-4 space-y-4">
                        {/* Contact Options */}
                        <div className="bg-white rounded-lg p-4 border border-gray-200">
                            <h2 className="font-semibold text-gray-900 mb-3">Get in Touch</h2>
                            <div className="space-y-3">
                                <a
                                    href="mailto:support@awoof.tech"
                                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                                >
                                    <Mail className="h-5 w-5 text-gray-600" />
                                    <div>
                                        <p className="text-sm font-medium text-gray-900">Email</p>
                                        <p className="text-xs text-gray-600">support@awoof.tech</p>
                                    </div>
                                </a>
                                <a
                                    href="tel:+2348000000000"
                                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                                >
                                    <Phone className="h-5 w-5 text-gray-600" />
                                    <div>
                                        <p className="text-sm font-medium text-gray-900">Phone</p>
                                        <p className="text-xs text-gray-600">+234 800 000 0000</p>
                                    </div>
                                </a>
                            </div>
                        </div>

                        {/* Submit Ticket */}
                        {!showForm ? (
                            <Button
                                onClick={() => setShowForm(true)}
                                className="w-full"
                            >
                                <MessageCircle className="h-4 w-4 mr-2" />
                                Submit a Ticket
                            </Button>
                        ) : (
                            <div className="bg-white rounded-lg p-4 border border-gray-200">
                                <h2 className="font-semibold text-gray-900 mb-4">Submit Support Ticket</h2>
                                <form onSubmit={handleSubmit} className="space-y-4">
                                    <div>
                                        <Label htmlFor="category">Category</Label>
                                        <select
                                            id="category"
                                            value={formData.category}
                                            onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                                            className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            <option value="general">General Inquiry</option>
                                            <option value="technical">Technical Issue</option>
                                            <option value="billing">Billing Question</option>
                                            <option value="account">Account Issue</option>
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
                                        <textarea
                                            id="message"
                                            value={formData.message}
                                            onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                                            placeholder="Please provide details about your issue..."
                                            rows={5}
                                            className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            required
                                        />
                                    </div>
                                    <div className="flex gap-2">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() => {
                                                setShowForm(false);
                                                setFormData({ subject: '', message: '', category: 'general' });
                                            }}
                                            className="flex-1"
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            type="submit"
                                            disabled={isSubmitting}
                                            className="flex-1"
                                        >
                                            <Send className="h-4 w-4 mr-2" />
                                            {isSubmitting ? 'Submitting...' : 'Submit'}
                                        </Button>
                                    </div>
                                </form>
                            </div>
                        )}

                        {/* Tickets List */}
                        {tickets.length > 0 && (
                            <div>
                                <h2 className="font-semibold text-gray-900 mb-3">Your Tickets</h2>
                                <div className="space-y-3">
                                    {tickets.map((ticket) => (
                                        <Link
                                            key={ticket.id}
                                            href={`/student/profile/support/${ticket.id}`}
                                            className="block bg-white rounded-lg p-4 border border-gray-200 hover:border-blue-200"
                                        >
                                            <div className="flex items-start justify-between mb-2">
                                                <h3 className="font-semibold text-gray-900">{ticket.subject}</h3>
                                                <span className={`text-xs font-medium px-2 py-1 rounded ${getStatusColor(ticket.status)}`}>
                                                    {ticket.status}
                                                </span>
                                            </div>
                                            <p className="text-xs text-gray-500">{formatDate(ticket.createdAt)}</p>
                                        </Link>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Web View */}
                <div className="hidden md:block">
                    <div className="container mx-auto max-w-4xl px-4 py-8">
                        <div className="flex items-center gap-3 mb-6">
                            <Link href="/student/profile">
                                <Button variant="ghost" size="sm">
                                    <ChevronLeft className="h-4 w-4 mr-2" />
                                    Back
                                </Button>
                            </Link>
                            <div className="flex items-center gap-2">
                                <Headphones className="h-6 w-6 text-gray-600" />
                                <h1 className="text-2xl font-semibold text-gray-900">Customer Support</h1>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            {/* Contact Options */}
                            <div className="lg:col-span-1">
                                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 sticky top-4">
                                    <h2 className="font-semibold text-gray-900 mb-4">Get in Touch</h2>
                                    <div className="space-y-4">
                                        <a
                                            href="mailto:support@awoof.tech"
                                            className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                                        >
                                            <Mail className="h-5 w-5 text-gray-600" />
                                            <div>
                                                <p className="text-sm font-medium text-gray-900">Email</p>
                                                <p className="text-xs text-gray-600">support@awoof.tech</p>
                                            </div>
                                        </a>
                                        <a
                                            href="tel:+2348000000000"
                                            className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                                        >
                                            <Phone className="h-5 w-5 text-gray-600" />
                                            <div>
                                                <p className="text-sm font-medium text-gray-900">Phone</p>
                                                <p className="text-xs text-gray-600">+234 800 000 0000</p>
                                            </div>
                                        </a>
                                    </div>
                                </div>
                            </div>

                            {/* Main Content */}
                            <div className="lg:col-span-2 space-y-6">
                                {!showForm ? (
                                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                                        <h2 className="font-semibold text-gray-900 mb-4">Submit a Support Ticket</h2>
                                        <p className="text-gray-600 mb-4">
                                            Have a question or need help? Submit a ticket and our support team will get back to you.
                                        </p>
                                        <Button onClick={() => setShowForm(true)}>
                                            <MessageCircle className="h-4 w-4 mr-2" />
                                            Submit a Ticket
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                                        <h2 className="font-semibold text-gray-900 mb-4">Submit Support Ticket</h2>
                                        <form onSubmit={handleSubmit} className="space-y-4">
                                            <div>
                                                <Label htmlFor="category-web">Category</Label>
                                                <select
                                                    id="category-web"
                                                    value={formData.category}
                                                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                                                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                >
                                                    <option value="general">General Inquiry</option>
                                                    <option value="technical">Technical Issue</option>
                                                    <option value="billing">Billing Question</option>
                                                    <option value="account">Account Issue</option>
                                                </select>
                                            </div>
                                            <div>
                                                <Label htmlFor="subject-web">Subject</Label>
                                                <Input
                                                    id="subject-web"
                                                    value={formData.subject}
                                                    onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                                                    placeholder="Brief description of your issue"
                                                    required
                                                />
                                            </div>
                                            <div>
                                                <Label htmlFor="message-web">Message</Label>
                                                <textarea
                                                    id="message-web"
                                                    value={formData.message}
                                                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                                                    placeholder="Please provide details about your issue..."
                                                    rows={6}
                                                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                                                    }}
                                                >
                                                    Cancel
                                                </Button>
                                                <Button
                                                    type="submit"
                                                    disabled={isSubmitting}
                                                >
                                                    <Send className="h-4 w-4 mr-2" />
                                                    {isSubmitting ? 'Submitting...' : 'Submit Ticket'}
                                                </Button>
                                            </div>
                                        </form>
                                    </div>
                                )}

                                {/* Tickets List */}
                                {tickets.length > 0 && (
                                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                                        <h2 className="font-semibold text-gray-900 mb-4">Your Support Tickets</h2>
                                        <div className="space-y-4">
                                            {tickets.map((ticket) => (
                                                <Link
                                                    key={ticket.id}
                                                    href={`/student/profile/support/${ticket.id}`}
                                                    className="block p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                                                >
                                                    <div className="flex items-start justify-between mb-2">
                                                        <h3 className="font-semibold text-gray-900">{ticket.subject}</h3>
                                                        <span className={`text-xs font-medium px-2 py-1 rounded ${getStatusColor(ticket.status)}`}>
                                                            {ticket.status}
                                                        </span>
                                                    </div>
                                                    <p className="text-xs text-gray-500">Created: {formatDate(ticket.createdAt)}</p>
                                                </Link>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </ProtectedRoute>
    );
}
