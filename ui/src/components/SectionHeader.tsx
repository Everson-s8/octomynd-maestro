export function SectionHeader({ eyebrow, title, meta }: { eyebrow: string; title: string; meta?: string }) {
  return (
    <header className="section-header">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {meta ? <small>{meta}</small> : null}
    </header>
  );
}
