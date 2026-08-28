import { useState } from 'react';
import type { DashboardLayoutProps } from './types';
import { DashboardSidebar } from './Sidebar';
import { DashboardTopbar } from './Topbar';
import { cn } from '@/lib/utils';

export function DashboardLayout({
    navItems,
    secondaryNavItems,
    pageTitle,
    subtitle,
    topbarActions,
    children,
    user,
    onLogout,
    logoutLabel,
}: DashboardLayoutProps) {
    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    const toggleMobileNav = () => setMobileNavOpen((prev) => !prev);
    const closeMobileNav = () => setMobileNavOpen(false);
    const handleMobileLogout = () => {
        closeMobileNav();
        onLogout?.();
    };

    return (
        <div className="h-screen overflow-hidden bg-[#F4F7FD]">
            <div
                aria-hidden
                className="pointer-events-none fixed inset-0 -z-10"
                style={{
                    background:
                        'radial-gradient(ellipse 60% 40% at 80% 0%, rgba(29,78,216,0.08), transparent 50%)',
                }}
            />
            <div className="flex h-full">
                <div className="hidden lg:block">
                    <DashboardSidebar
                        navItems={navItems}
                        secondaryNavItems={secondaryNavItems}
                        onLogout={onLogout}
                        logoutLabel={logoutLabel}
                    />
                </div>

                <div
                    className={cn(
                        'fixed inset-y-0 left-0 z-30 w-64 transition-transform duration-300 lg:hidden',
                        mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
                    )}
                >
                    <DashboardSidebar
                        navItems={navItems}
                        secondaryNavItems={secondaryNavItems}
                        onNavigate={closeMobileNav}
                        onLogout={handleMobileLogout}
                        logoutLabel={logoutLabel}
                    />
                </div>

                {mobileNavOpen && (
                    <div
                        className="fixed inset-0 z-20 bg-slate-900/40 backdrop-blur-sm lg:hidden"
                        onClick={closeMobileNav}
                    />
                )}

                <div className="flex min-h-0 flex-1 flex-col">
                    <DashboardTopbar
                        actions={topbarActions}
                        user={user}
                        onToggleSidebar={toggleMobileNav}
                        isSidebarOpen={mobileNavOpen}
                    />

                    <main className="flex-1 overflow-y-auto">
                        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
                            {(pageTitle || subtitle) && (
                                <div className="mb-6 md:mb-8">
                                    {pageTitle && (
                                        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900">
                                            {pageTitle}
                                        </h1>
                                    )}
                                    {subtitle && (
                                        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
                                    )}
                                </div>
                            )}
                            {children}
                        </div>
                    </main>
                </div>
            </div>
        </div>
    );
}
