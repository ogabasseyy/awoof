import PublicShell from './PublicShell';

export default function PublicPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <PublicShell>
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600">{intro}</p>
        <div className="mt-8">{children}</div>
      </div>
    </PublicShell>
  );
}
