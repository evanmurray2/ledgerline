// Settings pieces shared by every section: the page frame and a row that links to a page.
import { type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { BackHeader, cx, Icon, useIsDesktop } from '../../components/ui';

export function Page({
  title,
  back,
  right,
  footer,
  children,
}: {
  title: string;
  back: string;
  right?: ReactNode;
  /** Stays at the bottom while the page scrolls (Save buttons). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {desktop ? (
        <div className="flex items-center justify-between px-6 pt-5">
          <h2 className="m-0 text-[18px] font-bold">{title}</h2>
          {right}
        </div>
      ) : (
        <BackHeader
          title={title}
          onBack={() => void navigate({ to: back })}
          backLabel={`Back to ${back === '/settings' ? 'settings' : back === '/accounts' ? 'accounts' : back === '/budget' ? 'budget' : 'list'}`}
          right={right}
        />
      )}
      <div
        className={cx(
          'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3',
          desktop ? 'px-6 pb-8' : 'px-4 pb-6',
        )}
      >
        <div className={cx('flex flex-col gap-3', desktop && 'max-w-[680px]')}>{children}</div>
      </div>
      {footer && (
        <div className={cx('shrink-0 border-t border-line bg-surface py-3', desktop ? 'px-6' : 'px-4')}>
          <div className={cx(desktop && 'max-w-[680px]')}>{footer}</div>
        </div>
      )}
    </div>
  );
}

export function RowLink({
  to,
  name,
  meta,
  track,
}: {
  to: string;
  name: string;
  meta: string;
  track: string;
}) {
  return (
    <Link
      to={to}
      data-track={track}
      className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-[15px] font-semibold">{name}</span>
        <span className="text-[12px] text-muted">{meta}</span>
      </span>
      <Icon name="chevR" size={18} className="text-faint" />
    </Link>
  );
}
