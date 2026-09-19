// ファイル種別。適用条件の判定に使う決定論的な規則。拡張子とファイル名だけを見る。

import type { FileKind } from './output.js';
export type { FileKind };

const CODE_EXT = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'cs', 'php', 'lua', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'vue', 'svelte', 'astro',
]);

const CONFIG_EXT = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'env',
]);

const CONFIG_BASENAMES = new Set([
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
  'Dockerfile', 'Makefile', '.dockerignore',
]);

const DOC_EXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'asciidoc']);

export function fileKind(path: string): FileKind {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (CONFIG_BASENAMES.has(base) || base.startsWith('.env')) return 'config';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (CODE_EXT.has(ext)) return 'code';
  if (CONFIG_EXT.has(ext)) return 'config';
  if (DOC_EXT.has(ext)) return 'doc';
  return 'other';
}
