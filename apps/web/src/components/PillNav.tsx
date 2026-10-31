import { useLayoutEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";

export interface PillNavItem {
  to: string;
  label: string;
}

export function PillNav({ items }: { items: PillNavItem[] }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const containerRef = useRef<HTMLElement>(null);
  const linkEls = useRef(new Map<string, HTMLAnchorElement>());
  const [slider, setSlider] = useState<{ left: number; width: number } | null>(
    null,
  );

  const activeTo = items.find((item) =>
    item.to === "/" ? pathname === "/" : pathname.startsWith(item.to),
  )?.to;

  useLayoutEffect(() => {
    const measure = () => {
      const el = activeTo === undefined ? undefined : linkEls.current.get(activeTo);
      setSlider(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [activeTo]);

  return (
    <nav
      ref={containerRef}
      className="relative flex items-center gap-0.5 rounded-full border border-line bg-surface/70 p-1 shadow-[0_8px_30px_rgba(16,26,60,0.10)] backdrop-blur-xl dark:shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
    >
      {slider && (
        <span
          aria-hidden
          className="absolute bottom-1 top-1 rounded-full bg-accent-fill transition-[left,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
          style={{ left: slider.left, width: slider.width }}
        />
      )}
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          ref={(el: HTMLAnchorElement | null) => {
            if (el) {
              linkEls.current.set(item.to, el);
            } else {
              linkEls.current.delete(item.to);
            }
          }}
          className={`relative rounded-full px-4 py-1.5 text-sm transition-colors duration-300 ${
            activeTo === item.to
              ? "font-semibold text-accent-ink"
              : "font-medium text-muted hover:text-ink"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
