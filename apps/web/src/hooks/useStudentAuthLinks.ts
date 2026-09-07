'use client';

import { useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { createStudentAuthLinks, type StudentAuthLinks } from '@/lib/student-auth-links';

const subscribeOrigin = (listener: () => void) => {
  void listener;
  return () => {};
};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => null;

export function useStudentAuthLinks(): StudentAuthLinks {
  const search = useSearchParams();
  const origin = useSyncExternalStore(subscribeOrigin, getOrigin, getServerOrigin);
  return createStudentAuthLinks(search.get('redirect'), origin);
}
