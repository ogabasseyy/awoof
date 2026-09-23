import PublicFooter from './PublicFooter';
import PublicHeader from './PublicHeader';

export default function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-shell min-h-screen" style={{ background: 'var(--public-paper)' }}>
      <a href="#main-content" className="public-skip-link">
        Skip to content
      </a>
      <PublicHeader />
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
