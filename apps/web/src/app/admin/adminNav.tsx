/**
 * Shared admin sidebar/topbar nav. Use on every admin page so the full menu always shows.
 */

import { LayoutDashboard, Users, ShoppingBag, Tag, Settings, BarChart3, GraduationCap, LifeBuoy, Bell } from 'lucide-react';

const iconProps = { className: 'h-5 w-5', strokeWidth: 1.5, fill: 'currentColor' as const };

export const primaryNavItems = [
    { id: 'dashboard', label: 'Dashboard', href: '/admin/dashboard', icon: <LayoutDashboard {...iconProps} /> },
    { id: 'categories', label: 'Categories', href: '/admin/categories', icon: <Tag {...iconProps} /> },
    { id: 'universities', label: 'Universities', href: '/admin/universities', icon: <GraduationCap {...iconProps} /> },
    { id: 'students', label: 'Students', href: '/admin/students', icon: <Users {...iconProps} /> },
    { id: 'vendors', label: 'Vendors', href: '/admin/vendors', icon: <ShoppingBag {...iconProps} /> },
    { id: 'support', label: 'Support', href: '/admin/support', icon: <LifeBuoy {...iconProps} /> },
    { id: 'analytics', label: 'Analytics', href: '/admin/analytics', icon: <BarChart3 {...iconProps} /> },
];

export const secondaryNavItems = [
    { id: 'notifications', label: 'Notifications', href: '/admin/notifications', icon: <Bell {...iconProps} /> },
    { id: 'settings', label: 'Settings', href: '/admin/settings', icon: <Settings {...iconProps} /> },
];
