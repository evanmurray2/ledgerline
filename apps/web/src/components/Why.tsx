// "Why?": one short line on screen, the rest of the explanation behind a tap (design critique, Nov 4).
import { useState, type ReactNode } from 'react';
import { cx } from './ui';

export function Why({
  children,
  label = 'Why?',
  className,
  track,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  track?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className={cx('flex flex-col gap-1', className)}>
      <button
        type="button"
        aria-expanded={open}
        data-track={track}
        onClick={(e) => {
          // Inside a banner that is a link: open the text, don't follow the link.
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
        className="hit self-start text-sm font-bold underline"
      >
        {open ? 'Hide' : label}
      </button>
      {open && <span className="text-sm leading-snug">{children}</span>}
    </span>
  );
}

/**
 * One banner at a time: the first (most urgent) shows, the rest behind "N more". Pass them most urgent first.
 */
export function OneBanner({ items }: { items: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  if (shown.length === 1) return <>{shown[0]}</>;
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      {shown[0]}
      {open && shown.slice(1)}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hit self-start px-0.5 text-sm font-bold text-accent"
      >
        {open ? 'Show less' : `${shown.length - 1} more`}
      </button>
    </div>
  );
}
