import { describe, expect, it } from 'vitest';
import { sha256 } from '@mindly/core';
import {
  buildImportGraph,
  diffExportSurface,
  diffLines,
  extractExports,
  extractImports,
  hunkHashes,
  languageOf,
} from '../src/index.js';
import type { ExportedSymbol } from '../src/index.js';
import { tempDir, write } from './helpers.js';

const names = (syms: readonly ExportedSymbol[]): string[] => syms.map((s) => s.name);

describe('languageOf', () => {
  it('maps extensions and skips unknown languages', () => {
    expect(languageOf('src/a.ts')).toBe('typescript');
    expect(languageOf('src/A.TSX')).toBe('typescript');
    expect(languageOf('lib/x.cjs')).toBe('javascript');
    expect(languageOf('pkg/mod.py')).toBe('python');
    expect(languageOf('main.go')).toBeNull();
    expect(languageOf('Makefile')).toBeNull();
    expect(languageOf('.ts')).toBeNull();
    expect(extractExports('package main', null)).toEqual([]);
    expect(extractImports('import "fmt"', null)).toEqual([]);
  });
});

const TS_BEFORE = `
import { Db } from './db';
/** docs: export function commented() {} */
// export const alsoCommented = 1;
const fake = "export function inString() {}";
const tpl = \`export const inTemplate = \${1 + 1}\`;

export function add(a: number, b: number): number {
  return a + b;
}
export const mul = (a: number, b: number): number => a * b;
export interface User {
  id: string;
  name: string;
}
export type Role = 'admin' | 'user';
export class Service {
  constructor(private db: Db) {}
  get(id: string): User {
    return this.db.find(id);
  }
  private secret() {
    return 1;
  }
}
export enum Color {
  Red,
  Green,
}
export default function main() {}
const internal = 1;
function helper(x: string) {
  return x;
}
export { helper, internal as renamed };
export * from './other';
export { thing } from './thing';
export declare function overloaded(a: string): string;
export declare function overloaded(a: number): number;
export const { left, right: aliased } = { left: 1, right: 2 };
`;

const TS_AFTER = `
import { Db } from './db';

export function add(a: number, b: number, c = 0): number {
  return a + b + c;
}
export interface User {
  id: string;
  name: string;
  email: string;
}
export type Role = "admin" | "user";
export class Service {
  constructor(private db: Db) {}
  get(id: string): User {
    // implementation changed, surface did not
    return this.db.findOne(id);
  }
  private secret() {
    return 2;
  }
}
export enum Color {
  Red,
  Green,
}
export default function main() {}
const internal = 1;
function helper(x: string) { return x.trim(); }
export { helper, internal as renamed };
export * from './other';
export { thing } from './thing';
export declare function overloaded(a: string): string;
export declare function overloaded(a: number): number;
export const { left, right: aliased } = { left: 1, right: 2 };
export async function newer(): Promise<void> {}
`;

describe('extractExports (TypeScript)', () => {
  it('finds every export form and ignores comments and strings', () => {
    const exports = extractExports(TS_BEFORE, 'typescript');
    expect(names(exports)).toEqual([
      '*:./other',
      'Color',
      'Role',
      'Service',
      'User',
      'add',
      'aliased',
      'default',
      'helper',
      'left',
      'mul',
      'overloaded',
      'renamed',
      'thing',
    ]);
    const byName = new Map(exports.map((e) => [e.name, e]));
    expect(byName.get('add')).toMatchObject({
      kind: 'function',
      signature: '(a:number,b:number):number',
    });
    expect(byName.get('mul')).toMatchObject({
      kind: 'function',
      signature: '(a:number,b:number):number',
    });
    expect(byName.get('helper')).toMatchObject({ kind: 'function', signature: '(x:string)' });
    expect(byName.get('renamed')).toMatchObject({ kind: 'variable' });
    expect(byName.get('User')?.signature).toMatch(/^#[0-9a-f]{16}$/);
    expect(byName.get('overloaded')?.signature).toBe('(a:string):string | (a:number):number');
    expect(byName.get('thing')).toMatchObject({ kind: 'reexport' });
  });

  it('diffs export surfaces: added, removed and changed signatures', () => {
    const diff = diffExportSurface(
      extractExports(TS_BEFORE, 'typescript'),
      extractExports(TS_AFTER, 'typescript'),
    );
    expect(names(diff.added)).toEqual(['newer']);
    expect(names(diff.removed)).toEqual(['mul']);
    expect(diff.changed.map((c) => c.name)).toEqual(['User', 'add']);
  });

  it('handles JavaScript ESM and CommonJS', () => {
    const esm = extractExports(
      'export default class extends Base {}\nexport let a = 1, b = function (x, y) {};\n',
      'javascript',
    );
    expect(names(esm)).toEqual(['a', 'b', 'default']);
    expect(esm.find((e) => e.name === 'b')?.signature).toBe('(x,y)');
    const cjs = extractExports(
      `function run(opts) {}\nmodule.exports = { run, version: '1', start(port) {} };\nexports.extra = (a) => a;\n`,
      'javascript',
    );
    expect(names(cjs)).toEqual(['extra', 'run', 'start', 'version']);
    expect(cjs.find((e) => e.name === 'run')?.signature).toBe('(opts)');
    expect(cjs.find((e) => e.name === 'start')?.signature).toBe('(port)');
  });

  it('copes with regex literals, templates and odd input without throwing', () => {
    const src =
      'const re = /export function no\\/t[/]/g;\nexport const ok = `a${`b${1}`}`;\nexport function f(a = "}") {}\n';
    expect(names(extractExports(src, 'typescript'))).toEqual(['f', 'ok']);
    expect(() => extractExports('export function (((', 'typescript')).not.toThrow();
    expect(extractExports('x'.repeat(600 * 1024), 'typescript')).toEqual([]);
  });
});

const PY_BEFORE = `
import os
from typing import List

__version__ = "1.0"
CONSTANT = 5
LIMIT: int = 10

def public(a, b=2) -> int:
    return a

def _private():
    pass

class Model(Base):
    name: str
    def save(self, force=False):
        ...
    def _internal(self):
        ...

async def fetch(url: str,
                timeout: float = 1.0):
    """def not_a_function(): pass"""
    ...
`;

describe('extractExports (Python)', () => {
  it('lists public top-level names with signatures', () => {
    const exports = extractExports(PY_BEFORE, 'python');
    expect(names(exports)).toEqual(['CONSTANT', 'LIMIT', 'Model', 'fetch', 'public']);
    const byName = new Map(exports.map((e) => [e.name, e]));
    expect(byName.get('public')?.signature).toBe('(a,b=2)->int');
    expect(byName.get('fetch')?.signature).toBe('(url:str,timeout:float=1.0)');
    expect(byName.get('LIMIT')?.signature).toBe(':int');
  });

  it('detects changed class surfaces but not private or body changes', () => {
    const before = extractExports(PY_BEFORE, 'python');
    const privateOnly = extractExports(
      PY_BEFORE.replace('def _internal(self):', 'def _internal(self, x):').replace(
        'return a',
        'return a + 1',
      ),
      'python',
    );
    expect(diffExportSurface(before, privateOnly)).toEqual({ added: [], removed: [], changed: [] });
    const changed = extractExports(
      PY_BEFORE.replace('force=False', 'force=True, dry=False'),
      'python',
    );
    expect(diffExportSurface(before, changed).changed.map((c) => c.name)).toEqual(['Model']);
  });

  it('respects __all__', () => {
    const exports = extractExports(`${PY_BEFORE}\n__all__ = ['public', "_private"]\n`, 'python');
    expect(names(exports)).toEqual(['_private', 'public']);
  });
});

describe('extractImports', () => {
  it('extracts TS/JS specifiers in order, ignoring strings and comments', () => {
    const src = `
import a from './a';
import { b,
  c } from "../b.js";
import './side';
import type { F } from './f';
export { e } from './e';
export * as ns from './ns';
const d = require('./d');
const lazy = await import('./lazy');
const s = "import x from './nope'";
// import y from './commented'
obj.require('./member');
import a2 from './a';
`;
    expect(extractImports(src, 'typescript')).toEqual([
      './a',
      '../b.js',
      './side',
      './f',
      './e',
      './ns',
      './d',
      './lazy',
    ]);
  });

  it('extracts Python modules including relative and parenthesised imports', () => {
    const src = `
import os, sys as system
from . import utils, helpers as h
from .models import User
from ..pkg.mod import (
    a,
    b,
)
s = "import not_this"
# import commented
def f():
    import inner.mod
`;
    expect(extractImports(src, 'python')).toEqual([
      'os',
      'sys',
      '.utils',
      '.helpers',
      '.models',
      '..pkg.mod',
      'inner.mod',
    ]);
  });
});

describe('buildImportGraph', () => {
  it('resolves relative imports and answers dependents', async () => {
    const root = tempDir();
    write(root, 'src/a.ts', "import { b } from './b.js';\nimport u from './util';\n");
    write(root, 'src/b.ts', "export * from './c';\nimport lodash from 'lodash';\n");
    write(root, 'src/c.tsx', 'export const c = 1;\n');
    write(root, 'src/util/index.ts', 'export default 1;\n');
    write(root, 'src/legacy.cjs', "const c = require('./c');\n");
    write(root, 'node_modules/x/index.js', "require('../../src/c');\n");
    write(root, 'dist/out.js', "require('../src/c');\n");
    write(root, 'secrets/x.ts', "import '../src/c';\n");
    write(root, 'src/huge.ts', `import './c';\n${'// pad\n'.repeat(80_000)}`);
    write(root, 'pkg/__init__.py', '');
    write(root, 'pkg/helpers.py', 'X = 1\n');
    write(root, 'pkg/mod.py', 'from . import helpers\n');
    write(root, 'main.py', 'import pkg.mod\n');
    write(root, 'notes.md', "import './src/c'\n");

    const files = [
      'src/a.ts',
      'src/b.ts',
      'src/c.tsx',
      'src/util/index.ts',
      'src/legacy.cjs',
      'node_modules/x/index.js',
      'dist/out.js',
      'secrets/x.ts',
      'src/huge.ts',
      'pkg/__init__.py',
      'pkg/helpers.py',
      'pkg/mod.py',
      'main.py',
      'notes.md',
      '../outside.ts',
    ];
    const graph = await buildImportGraph(root, files);
    expect(graph.files).not.toContain('node_modules/x/index.js');
    expect(graph.files).not.toContain('secrets/x.ts');
    expect(graph.files).not.toContain('notes.md');
    expect(graph.dependenciesOf('src/a.ts')).toEqual(['src/b.ts', 'src/util/index.ts']);
    expect(graph.dependentsOf('src/c.tsx')).toEqual(['src/b.ts', 'src/legacy.cjs']);
    expect(graph.dependentsOf(`${root}/src/c.tsx`, { transitive: true })).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/legacy.cjs',
    ]);
    expect(graph.dependentsOf('src/util/index.ts')).toEqual(['src/a.ts']);
    expect(graph.dependentsOf('pkg/helpers.py')).toEqual(['pkg/mod.py']);
    expect(graph.dependentsOf('pkg/mod.py')).toEqual(['main.py']);
    expect(graph.dependentsOf('../etc/passwd')).toEqual([]);
  });
});

describe('hunk hashes', () => {
  it('hashes normalised non-trivial lines only', () => {
    const hashes = hunkHashes('  const a  =   1;\n\n}\n  return value;\r\nend\n');
    expect(hashes).toEqual([sha256('const a = 1;'), sha256('return value;')]);
    expect(hunkHashes('const a = 1;')).toEqual(hunkHashes('\tconst   a = 1;   '));
  });

  it('extracts added and removed lines from a unified diff', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old line',
      '+new line',
    ].join('\n');
    expect(diffLines(diff)).toEqual({ added: ['new line'], removed: ['old line'] });
  });
});
