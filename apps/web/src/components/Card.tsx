import { ReactNode } from "react";

export function Card({
  title,
  children,
  className = "",
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,26,60,0.05)] dark:shadow-none ${className}`}
    >
      {title !== undefined && (
        <h2 className="mb-3 text-sm font-semibold text-ink">{title}</h2>
      )}
      {children}
    </section>
  );
}
