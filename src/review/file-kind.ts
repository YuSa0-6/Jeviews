// ファイル種別。適用条件の判定に使う決定論的な規則。拡張子とファイル名だけを見る。

import type { FileKind } from './output.js';

export type { FileKind };
export type SourceLanguage = 'typescript' | 'ruby' | 'other';

// JavaScript は TypeScript と同じ言語として扱い、同じ閾値を使う。質問文が共通で、
// 判定する観点 (分岐・未使用・到達不能など) の書き方も両者で変わらないため。
// 閾値を分けたくなったら 'javascript' を足し、js 系の行をそちらへ移す。
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SourceLanguage>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  rb: 'ruby',
};

const CODE_EXT = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'swift',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'cs',
  'php',
  'lua',
  'dart',
  'ex',
  'exs',
  'erl',
  'hs',
  'ml',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'sql',
  'vue',
  'svelte',
  'astro',
]);

const CONFIG_EXT = new Set([
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'xml',
  'env',
]);

const CONFIG_BASENAMES = new Set([
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.eslintrc',
  'Dockerfile',
  'Makefile',
  '.dockerignore',
]);

const TEST_BASENAME = /([._](test|spec)\.[^.]+|^test_[^/]+\.py)$/;
const TEST_DIRS = new Set(['spec', 'test', 'tests', '__tests__']);
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)(\.[^.]+)?$/;

function isTestPath(path: string, base: string): boolean {
  if (TEST_BASENAME.test(base)) return true;
  return path
    .split('/')
    .slice(0, -1)
    .some((dir) => TEST_DIRS.has(dir));
}

const DOC_EXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'asciidoc']);

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 拡張子を小文字で返す。拡張子が無ければ空文字。 */
function extensionOf(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function fileKind(path: string): FileKind {
  const base = basename(path);
  if (TEMPLATE_SUFFIX.test(base)) return 'template';
  if (CONFIG_BASENAMES.has(base) || base.startsWith('.env')) return 'config';
  const ext = extensionOf(base);
  if (isTestPath(path, base)) return 'test';
  if (CODE_EXT.has(ext)) return 'code';
  if (CONFIG_EXT.has(ext)) return 'config';
  if (DOC_EXT.has(ext)) return 'doc';
  return 'other';
}

export function sourceLanguage(path: string): SourceLanguage {
  return LANGUAGE_BY_EXTENSION[extensionOf(basename(path))] ?? 'other';
}
