import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECKS } from './review/checks.js';

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('skills/jeview/SKILL.md', () => {
  const skill = read('../skills/jeview/SKILL.md');

  it('matches the agent context block in README word for word', () => {
    const block = read('../README.md').match(/^````markdown\n([\s\S]*?)^````$/m)?.[1];
    expect(block).toBe(skill);
  });

  it('explains every check the CLI asks about', () => {
    const listed = [...skill.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual(CHECKS.map((c) => c.id).sort());
  });
});

describe('README.md', () => {
  it('lists every check under the group it belongs to', () => {
    const listed = [...read('../README.md').matchAll(/^\| ([a-z_]+) \| `([a-z_]+)` \|/gm)].map(
      (m) => `${m[1]}/${m[2]}`,
    );
    expect(listed.sort()).toEqual(CHECKS.map((c) => `${c.group}/${c.id}`).sort());
  });
});
