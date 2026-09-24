import { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = 'https://awoof.tech'
  const launched = '2026-09-21'

  return [
    { url: baseUrl, lastModified: launched, changeFrequency: 'daily', priority: 1 },
    { url: `${baseUrl}/marketplace`, lastModified: launched, changeFrequency: 'daily', priority: 0.9 },
    { url: `${baseUrl}/trust`, lastModified: launched, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${baseUrl}/help`, lastModified: launched, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${baseUrl}/contact`, lastModified: launched, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${baseUrl}/partner`, lastModified: launched, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${baseUrl}/developers`, lastModified: launched, changeFrequency: 'monthly', priority: 0.6 },
    ...[
      { path: '/legal', lastModified: '2026-09-24' },
      { path: '/privacy', lastModified: '2026-09-24' },
      { path: '/privacy/v1-0', lastModified: '2026-09-24' },
      { path: '/terms', lastModified: '2026-09-24' },
      { path: '/terms/v1-0', lastModified: '2026-09-24' },
      { path: '/cookies', lastModified: '2026-09-23' },
      { path: '/legal/merchant-terms', lastModified: '2026-09-23' },
      { path: '/legal/data-protection', lastModified: '2026-09-23' },
    ].map(({ path, lastModified }) => ({
      url: `${baseUrl}${path}`, lastModified, changeFrequency: 'yearly' as const, priority: 0.4,
    })),
  ]
}
