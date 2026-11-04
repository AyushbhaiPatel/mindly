import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { describeError } from '../api';
import type { Severity, Trust } from '../types';
import {
  TERMS,
  absTime,
  relTime,
  severityWords,
  shortId,
  splitCode,
  trustHelp,
  trustWords,
  words,
  type Term,
  type Tone,
} from '../vocab';

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

const TRUST_GLYPH: Record<Trust, string> = {
  verified: '\u2713',
  approved: '\u25cf',
  proposed: '?',
  stale: '\u25cc',
  rejected: '\u2715',
};

/**
 * Trust level in words ("approved by you", "suggested by Codex, waiting for you"), with a
 * tooltip explaining what it means. `by` names who suggested a proposed memory.
 */
export function TrustBadge({ trust, by }: { trust: Trust; by?: string | undefined }) {
  return (
    <span className={`badge trust-${trust}`} title={trustHelp(trust)}>
      <span aria-hidden="true" className="badge-glyph">
        {TRUST_GLYPH[trust]}
      </span>
      {trustWords(trust, by)}
    </span>
  );
}

const SEV_GLYPH: Record<Severity, string> = { critical: '!!', warning: '!', info: 'i' };

/** Severity in words: FYI / check this / urgent. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`badge sev-${severity}`}>
      <span aria-hidden="true" className="badge-glyph">
        {SEV_GLYPH[severity]}
      </span>
      {severityWords(severity)}
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

/** A status tag. `label` is the plain-words text; the raw value only picks the colour. */
export function Status({ value, label }: { value: string; label?: string }) {
  return <Tag tone={statusTone(value)}>{label ?? words(value)}</Tag>;
}

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

/**
 * An 8-character short id with the full id in a tooltip and a button that copies the full id.
 */
export function ShortId({ id, label = 'id' }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const short = shortId(id);
  const copy = () => {
    void navigator.clipboard?.writeText(id).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <span className="short-id">
      <code className="mono" title={`Full ${label}: ${id}`}>
        {short}
      </code>
      <button
        type="button"
        className="copy-btn"
        onClick={(e) => {
          e.stopPropagation();
          copy();
        }}
        aria-label={copied ? `Copied ${label}` : `Copy full ${label} ${short}`}
        title={copied ? 'Copied' : `Copy full ${label}`}
      >
        <span aria-hidden="true">{copied ? '\u2713' : '\u29c9'}</span>
      </button>
    </span>
  );
}

/**
 * A small "?" that explains a term on hover or keyboard focus. The explanation is also the
 * button's accessible description.
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

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

/**
 * A titled panel. `count` is labelled with `noun` ("3 agents") for tooltips and screen readers;
 * `help` adds a "?" explaining the panel's term.
 */
export function Panel({
  title,
  count,
  noun = 'item',
  plural = `${noun}s`,
  help,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  count?: number | undefined;
  noun?: string;
  plural?: string;
  help?: Term;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const hid = useId();
  const countText = count !== undefined ? `${count} ${count === 1 ? noun : plural}` : '';
  return (
    <section className={cx('panel', className)} aria-labelledby={hid} id={id}>
      <header className="panel-head">
        <div className="panel-title">
          <h2 id={hid}>
            {title}
            {count !== undefined && (
              <span className="count" title={countText}>
                <span aria-hidden="true">{count}</span>
                <span className="visually-hidden">, {countText}</span>
              </span>
            )}
          </h2>
          {help && <Help term={help} />}
        </div>
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
