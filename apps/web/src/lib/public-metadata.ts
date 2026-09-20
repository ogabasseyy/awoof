import type { Metadata } from 'next';

export type PublicMetadataInput = {
  pathname: `/${string}`;
  title: string;
  description: string;
  socialImagePath?: `/${string}`;
};

const PRODUCTION_ORIGIN = 'https://awoof.tech';

export function buildPublicMetadata(input: PublicMetadataInput): Metadata {
  const url = new URL(input.pathname, PRODUCTION_ORIGIN).href;
  const images = input.socialImagePath
    ? [new URL(input.socialImagePath, PRODUCTION_ORIGIN).href]
    : undefined;
  return {
    title: { absolute: input.title },
    description: input.description,
    alternates: { canonical: url },
    openGraph: { title: input.title, description: input.description,
      url, siteName: 'Awoof', type: 'website', images },
    twitter: { title: input.title, description: input.description,
      card: images ? 'summary_large_image' : 'summary', images },
  };
}

export function assertValidPublicMetadataInput(input: {
  pathname: string;
  title: string;
  description: string;
  socialImagePath?: string;
}): asserts input is PublicMetadataInput {
  if (
    !input.pathname.startsWith('/')
    || input.pathname.startsWith('//')
    || input.pathname.includes('://')
    || input.pathname.includes('?')
    || input.pathname.includes('#')
  ) {
    throw new Error(`invalid pathname for public metadata: ${input.pathname}`);
  }
  if (input.socialImagePath !== undefined) {
    if (
      !input.socialImagePath.startsWith('/')
      || input.socialImagePath.startsWith('//')
      || input.socialImagePath.includes('://')
      || input.socialImagePath.includes('?')
      || input.socialImagePath.includes('#')
    ) {
      throw new Error(`invalid social image path for public metadata: ${input.socialImagePath}`);
    }
  }
  if (input.title.trim().length === 0) throw new Error('public metadata title must not be empty');
  if (input.description.trim().length === 0) throw new Error('public metadata description must not be empty');
}

export function assertUniqueCanonicals(inputs: readonly PublicMetadataInput[]): void {
  const seen = new Set<string>();
  for (const input of inputs) {
    const canonical = new URL(input.pathname, PRODUCTION_ORIGIN).href;
    if (seen.has(canonical)) throw new Error(`duplicate public canonical: ${canonical}`);
    seen.add(canonical);
  }
}
