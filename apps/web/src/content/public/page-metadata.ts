import type { PublicMetadataInput } from '../../lib/public-metadata';

// Trusted checked-in content only: never build entries from request/query input.
// Descriptions follow the Task 1 content contract (no unverified availability
// claims). Add approved legal routes only when their content is ready.
export const publicPageMetadata = {
  '/': {
    pathname: '/',
    title: 'Student Verification and Benefits | Awoof',
    description: 'Awoof explains student verification and how eligible students access benefits from participating merchants.',
  },
  '/trust': {
    pathname: '/trust',
    title: 'Security and Trust | Awoof',
    description: 'How Awoof handles verification evidence, what merchants learn, and the limits of each assurance level.',
  },
  '/help': {
    pathname: '/help',
    title: 'Student Verification Help | Awoof',
    description: 'Help with school email codes, pending or expired verification states, consent, and account recovery.',
  },
  '/contact': {
    pathname: '/contact',
    title: 'Contact Awoof',
    description: 'Reach student and vendor support, with sign-in expectations for account-specific help.',
  },
  '/partner': {
    pathname: '/partner',
    title: 'Student Verification for Partners | Awoof',
    description: 'How merchants and universities work with Awoof verification, from integration to student consent.',
  },
  '/developers': {
    pathname: '/developers',
    title: 'Developer Integration Guide | Awoof',
    description: 'Integration concepts for Awoof verification: server-side credentials, student consent, and verification checks.',
  },
  '/marketplace': {
    pathname: '/marketplace',
    title: 'Student Marketplace | Awoof',
    description: 'Browse student benefits from participating merchants. Each benefit states where and how it applies.',
  },
} satisfies Record<string, PublicMetadataInput>;
