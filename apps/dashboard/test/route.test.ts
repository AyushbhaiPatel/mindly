import { describe, expect, it } from 'vitest';
import {
  addressWithProject,
  canonicalRoute,
  formatRoute,
  parseRoute,
  projectOfRoute,
} from '../src/route';
import { PAGES } from '../src/vocab';

describe('parseRoute', () => {
  it('reads the page and its parameters', () => {
    expect(parseRoute('#/memory?p=abc&sub=x')).toEqual({
      page: 'memory',
      params: { p: 'abc', sub: 'x' },
    });
    expect(parseRoute('#/settings')).toEqual({ page: 'settings', params: {} });
    expect(parseRoute('')).toEqual({ page: 'home', params: {} });
    expect(parseRoute('#')).toEqual({ page: 'home', params: {} });
  });

  it('maps the older page names to a page and its section', () => {
    expect(parseRoute('#/overview')).toEqual({ page: 'home', params: {} });
    expect(parseRoute('#/split?p=abc')).toEqual({
      page: 'agents',
      params: { sub: 'split', p: 'abc' },
    });
    expect(parseRoute('#/runs').params).toEqual({ sub: 'runs' });
    // A section given in the address wins over the one the old name implies.
    expect(parseRoute('#/insight?sub=activity').params).toEqual({ sub: 'activity' });
  });

  it('opens the home page for any path that is not a page', () => {
    const pages = new Set(PAGES.map((p) => p.key));
    for (const path of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'nope',
      'Home',
      'memory/extra',
    ]) {
      const r = parseRoute(`#/${path}?p=abc`);
      expect(r.page, path).toBe('home');
      expect(pages.has(r.page)).toBe(true);
      expect(r.params).toEqual({ p: 'abc' });
    }
    expect(canonicalRoute('constructor', {}).page).toBe('home');
  });

  it('keeps a parameter named like an object member as plain data', () => {
    expect(parseRoute('#/home?__proto__=x&p=abc').params['p']).toBe('abc');
  });
});

describe('formatRoute', () => {
  it('writes an address parseRoute reads back', () => {
    expect(formatRoute('memory', { p: 'abc' })).toBe('#/memory?p=abc');
    expect(formatRoute('home')).toBe('#/home');
    expect(formatRoute('split', { p: 'abc' })).toBe('#/agents?sub=split&p=abc');
    expect(formatRoute('constructor', { p: 'abc' })).toBe('#/home?p=abc');
    for (const hash of ['#/history?p=a+b&sub=runs', '#/agents?sub=team&p=abc']) {
      const r = parseRoute(hash);
      expect(parseRoute(formatRoute(r.page, r.params))).toEqual(r);
    }
  });
});

describe('projectOfRoute', () => {
  const ids = ['p1', 'p2', 'p3'];
  const params = (q: string) => new URLSearchParams(q);

  it('follows the project the address names', () => {
    expect(projectOfRoute(params('p=p2'), ids, 'p1')).toBe('p2');
    // Back from p3 to an address that says p1.
    expect(projectOfRoute(params('p=p1&sub=team'), ids, 'p3')).toBe('p1');
  });

  it('keeps the project on screen when the address names none, or one that does not exist', () => {
    expect(projectOfRoute(params(''), ids, 'p3')).toBe('p3');
    expect(projectOfRoute(params('p=gone'), ids, 'p3')).toBe('p3');
    expect(projectOfRoute(params('p='), ids, 'p2')).toBe('p2');
  });

  it('falls back to the first project when nothing known is given', () => {
    expect(projectOfRoute(params('p=gone'), ids, 'also-gone')).toBe('p1');
    expect(projectOfRoute(params(''), ids, null)).toBe('p1');
    expect(projectOfRoute(params('p=x'), [], 'x')).toBeNull();
  });
});

describe('addressWithProject', () => {
  it('leaves an address that already names the project', () => {
    expect(addressWithProject('#/home?p=p1', 'p1')).toBeNull();
    expect(addressWithProject('#/agents?sub=team&p=p1', 'p1')).toBeNull();
  });

  it('adds the project to an address that names none', () => {
    expect(addressWithProject('', 'p1')).toBe('#/home?p=p1');
    expect(addressWithProject('#/memory', 'p1')).toBe('#/memory?p=p1');
    expect(addressWithProject('#/history?sub=runs', 'p1')).toBe('#/history?sub=runs&p=p1');
  });

  it('replaces a project that is not the one shown, keeping the page and its section', () => {
    expect(addressWithProject('#/settings?p=zzz', 'p1')).toBe('#/settings?p=p1');
    expect(addressWithProject('#/agents?p=gone&sub=split', 'p2')).toBe('#/agents?p=p2&sub=split');
    expect(addressWithProject('#/constructor?p=zzz', 'p1')).toBe('#/home?p=p1');
  });

  it('settles after one correction', () => {
    for (const hash of ['', '#/memory', '#/settings?p=zzz', '#/split', '#/nope?x=1']) {
      const fixed = addressWithProject(hash, 'p1');
      expect(fixed).not.toBeNull();
      expect(addressWithProject(fixed!, 'p1')).toBeNull();
    }
  });
});
