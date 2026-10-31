export function LogoMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 12V4.7M12 12l6.3-3.7M12 12l6.3 3.7M12 12v7.3M12 12l-6.3 3.7M12 12l-6.3-3.7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      <circle cx="12" cy="2.3" r="1.8" fill="currentColor" />
      <circle cx="20.4" cy="7.15" r="1.8" fill="currentColor" />
      <circle cx="20.4" cy="16.85" r="1.8" fill="currentColor" />
      <circle cx="12" cy="21.7" r="1.8" fill="currentColor" />
      <circle cx="3.6" cy="16.85" r="1.8" fill="currentColor" />
      <circle cx="3.6" cy="7.15" r="1.8" fill="currentColor" />
    </svg>
  );
}

export function LogoTile({ className = "" }: { className?: string }) {
  return (
    <span
      className={`flex size-8 items-center justify-center rounded-lg bg-[#4fd3e4] text-[#06283a] ${className}`}
    >
      <LogoMark size={18} />
    </span>
  );
}
