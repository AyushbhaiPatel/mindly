import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { describeError } from '../api';
import type { Severity, Trust } from '../types';
import {
  TERMS,
  absTime,
  moreWords,
  relTime,
  severityWords,
  shortAge,
  shortId,
  splitCode,
  trustHelp,
  trustShort,
  words,
  type Stat,
  type Term,
  type Tone,
} from '../vocab';

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------------------------------ */
/* Dots and status words                                                                       */
/* ------------------------------------------------------------------------------------------ */

const KNOWN_AGENT_KINDS = new Set(['claude-code', 'codex', 'cursor']);

/**
 * The 6px dot that starts a row. Colour carries meaning (tone, trust or agent) and is always
 * paired with a word in the same row, so it is hidden from assistive technology.
 */
export function Dot({ tone, agent }: { tone?: Tone | `trust-${Trust}`; agent?: string }) {
  const cls = agent
    ? `agent-${KNOWN_AGENT_KINDS.has(agent) ? agent : 'other'}`
    : tone?.startsWith('trust-')
      ? tone
      : `tone-${tone ?? 'neutral'}`;
  return <span className={cx('dot', cls)} aria-hidden="true" />;
}

/** A dot followed by its word: the one status element a row may have. */
export function DotWord({
  tone,
  children,
  title,
}: {
  tone: Tone | `trust-${Trust}`;
  children: ReactNode;
  title?: string | undefined;
}) {
  return (
    <span className="dot-word" title={title}>
      <Dot tone={tone} />
      <span>{children}</span>
    </span>
  );
}

/** Trust as dot + short word ("approved", "waiting for you"); the meaning is in the tooltip. */
export function TrustMark({ trust }: { trust: Trust }) {
  return (
    <DotWord tone={`trust-${trust}`} title={trustHelp(trust)}>
      {trustShort(trust)}
    </DotWord>
  );
}

const SEV_TONE: Record<Severity, Tone> = { critical: 'bad', warning: 'warn', info: 'info' };

/** Severity as dot + word: urgent / check this / FYI. */
export function SeverityMark({ severity }: { severity: Severity }) {
  return <DotWord tone={SEV_TONE[severity]}>{severityWords(severity)}</DotWord>;
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'active':
    case 'passed':
    case 'passing':
    case 'done':
    case 'acked':
    case 'completed':
    case 'claimed':
    case 'resolved':
      return 'good';
    case 'failed':
    case 'failing':
    case 'error':
    case 'blocked':
    case 'rate_limited':
      return 'bad';
    case 'running':
    case 'in_progress':
    case 'delivered':
    case 'queued':
      return 'info';
    case 'pending':
    case 'open':
    case 'acknowledged':
    case 'idle':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** A status as dot + word. `label` is the plain-words text; the raw value only picks the colour. */
export function Status({ value, label }: { value: string; label?: string }) {
  return <DotWord tone={statusTone(value)}>{label ?? words(value)}</DotWord>;
}

/* ------------------------------------------------------------------------------------------ */
/* Time                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/* One shared ticker keeps every relative time fresh without one timer per element. */
const tickers = new Set<() => void>();
let tickTimer: number | undefined;
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const fn = () => setNow(Date.now());
    tickers.add(fn);
    if (tickTimer === undefined) {
      tickTimer = window.setInterval(() => {
        for (const t of tickers) t();
      }, 20_000);
    }
    return () => {
      tickers.delete(fn);
      if (tickers.size === 0 && tickTimer !== undefined) {
        window.clearInterval(tickTimer);
        tickTimer = undefined;
      }
    };
  }, []);
  return now;
}

/** Relative time ("3m ago") with the absolute local time in a tooltip. */
export function Time({ ms, prefix }: { ms: number | null | undefined; prefix?: string }) {
  const now = useNow();
  if (!ms) return <span className="muted">{prefix ? `${prefix} never` : 'never'}</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={absTime(ms)}>
      {prefix ? `${prefix} ` : ''}
      {relTime(ms, now)}
    </time>
  );
}

/** Short age for time columns ("12s", "3m"), absolute time in the tooltip. */
export function Age({ ms }: { ms: number | null | undefined }) {
  const now = useNow();
  if (!ms) return <span className="muted">{'—'}</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={absTime(ms)}>
      {shortAge(ms, now)}
    </time>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Actions: gel primary, text links, icon buttons, overflow menu                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * A quiet text action. `go` adds "→" for actions that navigate ("Details →").
 * Secondary actions are always text links; the gel pill is reserved for the one primary action.
 */
export function TextLink({
  children,
  onClick,
  go,
  danger,
  disabled,
  type = 'button',
  label,
  expanded,
  controls,
}: {
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  go?: boolean;
  danger?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  label?: string;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <button
      type={type}
      className={cx('tlink', danger && 'tlink-danger')}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
    >
      {children}
      {go && (
        <span className="tlink-arrow" aria-hidden="true">
          {' →'}
        </span>
      )}
    </button>
  );
}

/** Borderless 28px icon button (copy, close, expand). */
export function IconBtn({
  label,
  onClick,
  children,
  expanded,
  controls,
  className,
}: {
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  expanded?: boolean | undefined;
  controls?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <button
      type="button"
      className={cx('icon-btn', className)}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={controls}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

export interface MenuItem {
  label: string;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * The "⋯" overflow menu for rare and destructive actions. Menu-button pattern: arrow keys
 * move, Escape or Tab closes and returns focus, clicking outside closes.
 */
export function Overflow({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    refs.current.find((r) => r && !r.disabled)?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const enabled = refs.current.filter((r): r is HTMLButtonElement => !!r && !r.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = enabled.length;
      if (n === 0) return;
      const next = e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      enabled[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? enabled[0] : enabled.at(-1))?.focus();
    }
  };

  return (
    <span className="menu-wrap" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="icon-btn menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title="More actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">{'⋯'}</span>
      </button>
      {open && (
        <span role="menu" id={id} className="menu" aria-label={label} onKeyDown={onKey}>
          {items.map((it, i) => (
            <button
              key={it.label}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={it.disabled}
              className={cx('menu-item', it.danger && 'menu-danger')}
              onClick={(e) => {
                e.stopPropagation();
                close(true);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** Copies text to the clipboard; returns whether the last copy just succeeded. */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return [copied, copy];
}

/**
 * An id for expanded details only: the 8-character short id, the full id in a tooltip, and a
 * borderless copy icon that copies the full id.
 */
export function CopyId({ id, label = 'id' }: { id: string; label?: string }) {
  const [copied, copy] = useCopy();
  const short = shortId(id);
  return (
    <span className="copy-id">
      <code className="mono" title={`Full ${label}: ${id}`}>
        {short}
      </code>
      <IconBtn
        label={copied ? `Copied ${label}` : `Copy full ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          copy(id);
        }}
      >
        {copied ? '✓' : '⧉'}
      </IconBtn>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Text                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * A small "?" that explains a term on hover or keyboard focus. The explanation is also the
 * button's accessible description. Explanations live here, never in the page body.
 */
export function Help({ term }: { term: Term }) {
  const id = useId();
  const text = TERMS[term];
  const name = text.split(':')[0] ?? term;
  return (
    <span className="help-tip">
      <button
        type="button"
        className="help-btn"
        aria-label={`What is ${name.toLowerCase()}?`}
        aria-describedby={id}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      >
        ?
      </button>
      <span role="tooltip" id={id} className="help-pop">
        {text}
      </span>
    </span>
  );
}

/** Renders text containing `backtick` spans as text with inline code. Never parses HTML. */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {splitCode(text).map((p, i) =>
        p.code ? (
          <code key={i} className="mono">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string | undefined }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

/** File paths as plain mono text, comma separated, truncated with "+2 more". */
export function Paths({ paths, max = 2 }: { paths: readonly string[]; max?: number }) {
  if (paths.length === 0) return <span className="muted">{'—'}</span>;
  const shown = paths.slice(0, max);
  const rest = paths.length - shown.length;
  return (
    <span className="paths" title={rest > 0 ? paths.join(', ') : undefined}>
      {shown.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && ', '}
          <code className="mono">{p}</code>
        </Fragment>
      ))}
      {rest > 0 && <span className="paths-more"> {moreWords(rest)}</span>}
    </span>
  );
}

/** A definition list of label/value pairs; falsy values are skipped. */
export function Facts({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl className="facts">
      {items
        .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '')
        .map(([k, v]) => (
          <div key={k} className="fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Layout                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * A section: label, optional "?" tooltip, a quiet meta value on the right ("3 open") and at most
 * one action area.
 */
export function Panel({
  title,
  help,
  meta,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  help?: Term;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const hid = useId();
  return (
    <section className={cx('panel', className)} aria-labelledby={hid} id={id}>
      <header className="panel-head">
        <div className="panel-title">
          <h2 id={hid}>{title}</h2>
          {help && <Help term={help} />}
        </div>
        {(meta !== undefined || actions) && (
          <div className="panel-actions">
            {meta !== undefined && <span className="panel-meta">{meta}</span>}
            {actions}
          </div>
        )}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** Large serif numerals with a small label underneath. */
export function StatRow({ stats }: { stats: Stat[] }) {
  return (
    <dl className="stats">
      {stats.map((s) => {
        const word = !/^\d+$/.test(s.value);
        return (
          <div key={s.label} className={cx('stat', word && 'stat-word')}>
            <dt>
              {word && <Dot tone={s.tone} />}
              {s.label}
              {s.at !== undefined && s.at !== null && (
                <>
                  {' · '}
                  <Age ms={s.at} />
                </>
              )}
            </dt>
            <dd>{s.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <span>{describeError(error)}</span>
      {onRetry && <TextLink onClick={onRetry}>Retry</TextLink>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="pulse" aria-hidden="true" />
      {label}…
    </p>
  );
}

/** Renders loading / error / content for a Resource. */
export function Loaded<T>({
  res,
  children,
}: {
  res: { data: T | undefined; error: unknown; loading: boolean; reload(): void };
  children: (data: T) => ReactNode;
}) {
  if (res.data !== undefined) return <>{children(res.data)}</>;
  if (res.error) return <ErrorNote error={res.error} onRetry={res.reload} />;
  return <Loading />;
}

/* ------------------------------------------------------------------------------------------ */
/* Tables                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  /** Header text; also the label of the value when the table stacks on phones. */
  header: string;
  cell(row: T): ReactNode;
  /**
   * main: takes the remaining width and truncates to one line; clip: truncates at a fixed max
   * width; meta: right-aligned quiet text (times, counts); plain: as is.
   */
  kind?: 'main' | 'clip' | 'meta' | 'plain';
  /** Full text for the tooltip of a truncated cell. */
  title?(row: T): string | undefined;
}

/**
 * The one table used everywhere: a quiet header row, one-line rows, details only when a row is
 * expanded (click the row or its chevron), an optional "⋯" menu per row. On phones it
 * stacks into label/value rows (see styles.css).
 */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  detail,
  menu,
  onOpen,
  isCurrent,
  menuLabel,
  className,
  head = true,
}: {
  label: string;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey(row: T): string;
  detail?: (row: T) => ReactNode;
  menu?: (row: T) => MenuItem[];
  /** Opens the row elsewhere (drawer, panel) instead of expanding it. */
  onOpen?: (row: T) => void;
  isCurrent?: (row: T) => boolean;
  menuLabel?: (row: T) => string;
  className?: string | undefined;
  head?: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const base = useId();
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const extra = (detail ? 1 : 0) + (menu ? 1 : 0);
  // With onOpen, the main column's content is a real button so the row is keyboard reachable.
  const openCol = Math.max(
    0,
    columns.findIndex((c) => c.kind === 'main'),
  );
  const span = columns.length + extra;
  const interactive = (t: EventTarget | null) =>
    t instanceof Element && !!t.closest('button, a, input, select, textarea, [role="menu"]');

  return (
    <table className={cx('dt', className)} aria-label={label}>
      {head && (
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`c-${c.kind ?? 'plain'}`}>
                {c.header}
              </th>
            ))}
            {menu && (
              <th scope="col" className="c-icon">
                <span className="visually-hidden">Actions</span>
              </th>
            )}
            {detail && (
              <th scope="col" className="c-icon">
                <span className="visually-hidden">Details</span>
              </th>
            )}
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((r) => {
          const k = rowKey(r);
          const isOpen = open.has(k);
          const did = `${base}-${k}`;
          const content = detail ? detail(r) : null;
          const canExpand = content !== null && content !== undefined && content !== false;
          return (
            <Fragment key={k}>
              <tr
                className={cx(
                  'dt-row',
                  isOpen && 'is-open',
                  isCurrent?.(r) && 'is-current',
                  canExpand && 'can-expand',
                  onOpen && 'can-open',
                )}
                aria-current={isCurrent?.(r) ? 'true' : undefined}
                onClick={(e) => {
                  if (interactive(e.target)) return;
                  if (canExpand) toggle(k);
                  else onOpen?.(r);
                }}
              >
                {columns.map((c, ci) => (
                  <td
                    key={c.key}
                    className={`c-${c.kind ?? 'plain'}`}
                    data-label={c.header}
                    title={c.title?.(r)}
                  >
                    <span className="cell">
                      {onOpen && ci === openCol ? (
                        <button type="button" className="row-open" onClick={() => onOpen(r)}>
                          {c.cell(r)}
                        </button>
                      ) : (
                        c.cell(r)
                      )}
                    </span>
                  </td>
                ))}
                {menu && (
                  <td className="c-icon c-menu">
                    <Overflow items={menu(r)} label={menuLabel?.(r) ?? 'More actions'} />
                  </td>
                )}
                {detail && (
                  <td className="c-icon c-toggle">
                    {canExpand && (
                      <IconBtn
                        label={isOpen ? 'Hide details' : 'Show details'}
                        expanded={isOpen}
                        controls={isOpen ? did : undefined}
                        className="chev"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(k);
                        }}
                      >
                        {'▸'}
                      </IconBtn>
                    )}
                  </td>
                )}
              </tr>
              {isOpen && canExpand && (
                <tr className="dt-detail" id={did}>
                  <td colSpan={span}>{content}</td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Dialogs                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Modal side drawer built on <dialog>: focus trap, Escape and backdrop click close it. */
export function Drawer({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const hid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx('drawer', wide && 'drawer-wide')}
      aria-labelledby={hid}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="drawer-inner">
          <header className="drawer-head">
            <h2 id={hid}>{title}</h2>
            <IconBtn label="Close" onClick={onClose}>
              {'✕'}
            </IconBtn>
          </header>
          <div className="drawer-body">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** Confirmation dialog for destructive or machine-affecting actions. */
export function Confirm({
  open,
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const hid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="confirm" aria-labelledby={hid} onClose={onCancel}>
      {open && (
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm();
          }}
        >
          <h2 id={hid}>{title}</h2>
          <div className="confirm-body">{children}</div>
          <div className="confirm-actions">
            <button type="button" className="tlink" onClick={onCancel} autoFocus>
              Cancel
            </button>
            <button type="submit" className={cx('btn-primary', danger && 'btn-primary-danger')}>
              {confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Navigation                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface TabDef<K extends string> {
  key: K;
  label: ReactNode;
}

/** WAI-ARIA tabs with roving tabindex and arrow/Home/End keys. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: TabDef<NoInfer<K>>[];
  value: K;
  onChange(k: NoInfer<K>): void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(tabs[n]!.key);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {tabs.map((t, i) => (
        <button
          key={t.key}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          id={`${idPrefix}-tab-${t.key}`}
          aria-selected={t.key === value}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={t.key === value ? 0 : -1}
          className="tab"
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A quiet segmented filter: text options with an underline (radio group semantics). */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: NoInfer<K>; label: ReactNode }[];
  value: K;
  onChange(k: NoInfer<K>): void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      n = (i - 1 + options.length) % options.length;
    if (n < 0) return;
    e.preventDefault();
    onChange(options[n]!.key);
    refs.current[n]?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.key}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          tabIndex={o.key === value ? 0 : -1}
          className="seg"
          onClick={() => onChange(o.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      className="meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <div className={cx('meter-fill', pct > 90 && 'meter-hot')} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Pretty JSON of untrusted data, rendered as text. */
export function JsonBlock({ value }: { value: unknown }) {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    s = String(value);
  }
  return <pre className="pre">{s.length > 20_000 ? `${s.slice(0, 20_000)}\n…` : s}</pre>;
}
