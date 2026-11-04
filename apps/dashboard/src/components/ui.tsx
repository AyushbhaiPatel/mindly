import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { describeError } from '../api';
import { absTime, relTime, type Tone } from '../format';
import type { Severity, Trust } from '../types';

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

const TRUST_HINT: Record<Trust, string> = {
  verified: 'Checked against the repository',
  approved: 'Stated or approved by you',
  proposed: 'Asserted by an agent, not yet confirmed',
  stale: 'Evidence changed; kept for history',
  rejected: 'Rejected; never injected again',
};

const TRUST_GLYPH: Record<Trust, string> = {
  verified: '✓',
  approved: '●',
  proposed: '?',
  stale: '◌',
  rejected: '✕',
};

export function TrustBadge({ trust }: { trust: Trust }) {
  return (
    <span className={`badge trust-${trust}`} title={TRUST_HINT[trust]}>
      <span aria-hidden="true" className="badge-glyph">
        {TRUST_GLYPH[trust]}
      </span>
      {trust}
    </span>
  );
}

const SEV_GLYPH: Record<Severity, string> = { critical: '!!', warning: '!', info: 'i' };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`badge sev-${severity}`}>
      <span aria-hidden="true" className="badge-glyph">
        {SEV_GLYPH[severity]}
      </span>
      {severity}
    </span>
  );
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`tag tone-${tone}`}>{children}</span>;
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

export function Status({ value }: { value: string }) {
  return <Tag tone={statusTone(value)}>{value.replace(/_/g, ' ')}</Tag>;
}

export function Time({ ms }: { ms: number | null | undefined }) {
  if (!ms) return <span className="muted">—</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={absTime(ms)}>
      {relTime(ms)}
    </time>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

export function Panel({
  title,
  count,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  count?: number | undefined;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const hid = useId();
  return (
    <section className={cx('panel', className)} aria-labelledby={hid} id={id}>
      <header className="panel-head">
        <h2 id={hid}>
          {title}
          {count !== undefined && <span className="count">{count}</span>}
        </h2>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <span>{describeError(error)}</span>
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
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
            <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
              Esc
            </button>
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
            <button type="button" className="btn" onClick={onCancel} autoFocus>
              Cancel
            </button>
            <button type="submit" className={cx('btn', danger ? 'btn-danger' : 'btn-primary')}>
              {confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

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

/** A small segmented filter (radio group semantics). */
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
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          className="seg"
          onClick={() => onChange(o.key)}
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

export function useConfirm() {
  const [state, setState] = useState<{ key: string } | null>(null);
  return {
    pending: state?.key ?? null,
    ask: (key: string) => setState({ key }),
    clear: () => setState(null),
  };
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
