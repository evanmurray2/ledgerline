// Settings pieces shared by every section: the page frame and a row that links to a page.
import { type ReactNode } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { BackHeader, cx, DESKTOP_WIDTH, Icon, PageFrame, useIsDesktop } from '../../components/ui';
import { useBack } from '../../lib/back';

export function Page({
  title,
  back,
  backSearch,
  right,
  footer,
  children,
}: {
  title: string;
  back: string;
  /** Kept on the way back, e.g. the Budget's month. */
  backSearch?: Record<string, string | undefined>;
  right?: ReactNode;
  /** Stays at the bottom while the page scrolls (Save buttons). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const isDesktop = useIsDesktop();
  const navigate = useNavigate();
  // Opened from another page (Users → Backup and export): Back returns there (lib/back.ts).
  const ret = useBack();
  // Inside Settings the page sits in the right-hand pane under the Settings header. Elsewhere on desktop
  // (Categories, opened from Budget) it is a screen of its own, with the same header as every other screen.
  const inPane = useRouterState({ select: (s) => s.location.pathname.startsWith('/settings') });
  const desktop = isDesktop && inPane;
  const width = isDesktop ? (inPane ? 'max-w-[680px]' : DESKTOP_WIDTH) : undefined;
  // In the Settings pane on a computer, switching sections doesn't slide (the list beside it stays put).
  return (
    <PageFrame still={desktop}>
      {!desktop && (
        <BackHeader
          title={title}
          onBack={ret ? ret.go : () => void navigate({ to: back, search: backSearch })}
          backLabel={
            ret?.label ??
            `Back to ${back === '/settings' ? 'settings' : back === '/accounts' ? 'accounts' : back === '/budget' ? 'budget' : 'list'}`
          }
          right={right}
        />
      )}
      {/* The same padding as ScreenBody. In the Settings pane the page title is the first row of the column. */}
      <div
        className={cx(
          'flex min-h-0 flex-1 flex-col overflow-y-auto',
          isDesktop ? 'px-6 pb-8 pt-5' : 'px-4 pb-6 pt-3',
        )}
      >
        <div className={cx('flex flex-col gap-3', width)}>
          {desktop && (
            <div className="flex min-h-9 items-center justify-between gap-3">
              <h2 className="m-0 text-xl font-bold">{title}</h2>
              {right}
            </div>
          )}
          {children}
        </div>
      </div>
      {footer && (
        <div className={cx('shrink-0 border-t border-line bg-surface py-3', isDesktop ? 'px-6' : 'px-4')}>
          <div className={width}>{footer}</div>
        </div>
      )}
    </PageFrame>
  );
}

export function RowLink({
  to,
  search,
  name,
  meta,
  warn,
  track,
}: {
  to: string;
  /** Search for the page it opens, e.g. its `back` (lib/back.ts). */
  search?: Record<string, string>;
  name: string;
  meta: string;
  /** The meta line needs the owner (a bank to sign in to again): the warn color, as on Accounts. */
  warn?: boolean;
  track: string;
}) {
  return (
    <Link
      to={to}
      search={search}
      data-track={track}
      className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-base font-semibold">{name}</span>
        <span className={cx('text-xs', warn ? 'text-warn-fg' : 'text-muted')}>{meta}</span>
      </span>
      <Icon name="chevR" size={18} className="text-faint" />
    </Link>
  );
}
