import type { CSSProperties } from 'react';

interface LogoProps {
  /** Use white on blue backgrounds, blue on light backgrounds. */
  color?: 'blue' | 'white';
  variant?: 'wordmark' | 'icon';
  className?: string;
  width?: number;
  height?: number;
}

export default function Logo({
  color = 'blue',
  variant = 'wordmark',
  className,
  width = variant === 'icon' ? 40 : 120,
  height = 40,
}: LogoProps) {
  const asset = variant === 'icon' ? '/icon.png' : '/images/awoof-wordmark.webp';
  const renderedHeight = variant === 'wordmark' ? Math.max(height, Math.round(width / 3)) : height;
  const style: CSSProperties = {
    display: 'inline-block',
    flexShrink: 0,
    width,
    height: renderedHeight,
    backgroundColor: color === 'white' ? '#fff' : '#244ee7',
    WebkitMaskImage: `url(${asset})`,
    maskImage: `url(${asset})`,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: variant === 'icon' ? 'contain' : 'auto 153%',
    maskSize: variant === 'icon' ? 'contain' : 'auto 153%',
  };

  return <span role="img" aria-label="Awoof" data-brand-variant={color} data-brand-form={variant} className={className} style={style} />;
}
