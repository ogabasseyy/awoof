/**
 * Notifications Page
 */

'use client';

import { useState, useEffect } from 'react';
import { Bell, ChevronLeft, Check, X } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import apiClient from '@/lib/api-client';

interface Notification {
    id: string;
    title: string;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
    read: boolean;
    createdAt: string;
}

export default function NotificationsPage() {
    const { } = useAuth();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);

    useEffect(() => {
        fetchNotifications();
    }, []);

    const fetchNotifications = async () => {
        try {
            setIsLoading(true);
            const response = await apiClient.get('/students/notifications');
            if (response?.data?.data?.notifications) {
                setNotifications(response.data.data.notifications);
                setUnreadCount(response.data.data.unreadCount || 0);
            }
        } catch (error) {
            console.error('Error fetching notifications:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const markAsRead = async (id: string) => {
        try {
            await apiClient.put('/students/notifications/read', { notificationIds: [id] });
            setNotifications(notifications.map(n => n.id === id ? { ...n, read: true, readAt: new Date().toISOString() } : n));
            setUnreadCount(Math.max(0, unreadCount - 1));
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    };

    const markAllAsRead = async () => {
        try {
            await apiClient.put('/students/notifications/read', { markAll: true });
            setNotifications(notifications.map(n => ({ ...n, read: true, readAt: new Date().toISOString() })));
            setUnreadCount(0);
        } catch (error) {
            console.error('Error marking all as read:', error);
        }
    };

    const deleteNotification = async (id: string) => {
        try {
            await apiClient.delete(`/students/notifications/${id}`);
            const notification = notifications.find(n => n.id === id);
            setNotifications(notifications.filter(n => n.id !== id));
            if (notification && !notification.read) {
                setUnreadCount(Math.max(0, unreadCount - 1));
            }
        } catch (error) {
            console.error('Error deleting notification:', error);
        }
    };

    const formatTime = (dateString: string) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
        if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
        return date.toLocaleDateString();
    };

    const getTypeColor = (type: string) => {
        switch (type) {
            case 'success':
                return 'bg-green-100 text-green-800';
            case 'warning':
                return 'bg-yellow-100 text-yellow-800';
            case 'error':
                return 'bg-red-100 text-red-800';
            default:
                return 'bg-blue-100 text-blue-800';
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
                            <div className="flex-1 flex items-center gap-2">
                                <Bell className="h-5 w-5 text-gray-600" />
                                <h1 className="text-lg font-semibold text-gray-900">Notifications</h1>
                                {unreadCount > 0 && (
                                    <span className="bg-red-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
                                        {unreadCount}
                                    </span>
                                )}
                            </div>
                            {unreadCount > 0 && (
                                <button
                                    onClick={markAllAsRead}
                                    className="text-sm text-blue-600 font-medium"
                                >
                                    Mark all read
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="px-4 py-4 space-y-3">
                        {isLoading ? (
                            <div className="text-center py-12">
                                <p className="text-gray-500">Loading notifications...</p>
                            </div>
                        ) : notifications.length === 0 ? (
                            <div className="text-center py-12">
                                <Bell className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                                <p className="text-gray-500">No notifications</p>
                            </div>
                        ) : (
                            notifications.map((notification) => (
                                <div
                                    key={notification.id}
                                    className={`bg-white rounded-lg p-4 border-l-4 ${notification.read ? 'border-gray-200' : 'border-blue-500'
                                        } ${!notification.read ? 'bg-blue-50' : ''}`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className={`text-xs font-medium px-2 py-0.5 rounded ${getTypeColor(notification.type)}`}>
                                                    {notification.type}
                                                </span>
                                                {!notification.read && (
                                                    <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                                                )}
                                            </div>
                                            <h3 className="font-semibold text-gray-900 mb-1">{notification.title}</h3>
                                            <p className="text-sm text-gray-600 mb-2">{notification.message}</p>
                                            <p className="text-xs text-gray-400">{formatTime(notification.createdAt)}</p>
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            {!notification.read && (
                                                <button
                                                    onClick={() => markAsRead(notification.id)}
                                                    className="p-1 hover:bg-gray-100 rounded"
                                                    title="Mark as read"
                                                >
                                                    <Check className="h-4 w-4 text-gray-600" />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => deleteNotification(notification.id)}
                                                className="p-1 hover:bg-gray-100 rounded"
                                                title="Delete"
                                            >
                                                <X className="h-4 w-4 text-gray-600" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Web View */}
                <div className="hidden md:block">
                    <div className="container mx-auto max-w-4xl px-4 py-8">
                        <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-3">
                                <Link href="/student/profile">
                                    <Button variant="ghost" size="sm">
                                        <ChevronLeft className="h-4 w-4 mr-2" />
                                        Back
                                    </Button>
                                </Link>
                                <div className="flex items-center gap-2">
                                    <Bell className="h-6 w-6 text-gray-600" />
                                    <h1 className="text-2xl font-semibold text-gray-900">Notifications</h1>
                                    {unreadCount > 0 && (
                                        <span className="bg-red-500 text-white text-xs font-semibold px-2 py-1 rounded-full">
                                            {unreadCount} unread
                                        </span>
                                    )}
                                </div>
                            </div>
                            {unreadCount > 0 && (
                                <Button onClick={markAllAsRead} variant="outline" size="sm">
                                    Mark all as read
                                </Button>
                            )}
                        </div>

                        <div className="space-y-4">
                            {isLoading ? (
                                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
                                    <p className="text-gray-500">Loading notifications...</p>
                                </div>
                            ) : notifications.length === 0 ? (
                                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
                                    <Bell className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                                    <p className="text-gray-500">No notifications</p>
                                </div>
                            ) : (
                                notifications.map((notification) => (
                                    <div
                                        key={notification.id}
                                        className={`bg-white rounded-lg shadow-sm border-l-4 p-6 ${notification.read ? 'border-gray-200' : 'border-blue-500'
                                            } ${!notification.read ? 'bg-blue-50' : ''}`}
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-3 mb-2">
                                                    <span className={`text-xs font-medium px-2 py-1 rounded ${getTypeColor(notification.type)}`}>
                                                        {notification.type}
                                                    </span>
                                                    {!notification.read && (
                                                        <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                                                    )}
                                                </div>
                                                <h3 className="text-lg font-semibold text-gray-900 mb-2">{notification.title}</h3>
                                                <p className="text-gray-600 mb-3">{notification.message}</p>
                                                <p className="text-sm text-gray-400">{formatTime(notification.createdAt)}</p>
                                            </div>
                                            <div className="flex gap-2">
                                                {!notification.read && (
                                                    <button
                                                        onClick={() => markAsRead(notification.id)}
                                                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                                                        title="Mark as read"
                                                    >
                                                        <Check className="h-5 w-5 text-gray-600" />
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => deleteNotification(notification.id)}
                                                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                                                    title="Delete"
                                                >
                                                    <X className="h-5 w-5 text-gray-600" />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </ProtectedRoute>
    );
}
