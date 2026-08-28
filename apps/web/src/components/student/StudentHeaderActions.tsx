'use client';

import Link from 'next/link';
import { NotificationBell } from '@/components/dashboard/NotificationBell';

interface StudentHeaderActionsProps {
    /** Show profile avatar link (marketplace). Omit on profile hub. */
    avatarLetter?: string;
    showProfileLink?: boolean;
}

export function StudentHeaderActions({
    avatarLetter,
    showProfileLink = false,
}: StudentHeaderActionsProps) {
    return (
        <div className="flex items-center gap-2 shrink-0">
            <NotificationBell />
            {showProfileLink && avatarLetter ? (
                <Link href="/student/profile" aria-label="Open profile">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1D4ED8] text-sm font-bold text-white shadow-md shadow-[#1D4ED8]/25 ring-2 ring-white">
                        {avatarLetter}
                    </span>
                </Link>
            ) : null}
        </div>
    );
}
