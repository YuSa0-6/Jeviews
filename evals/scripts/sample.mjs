// 各 repo から決定的に 2 つの部分集合 (tune / holdout) を選び、単独の git repo として evals/.work に作る。
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, evalDir, git, hash32, repoDir, workDir } from './lib.mjs';

const only = process.argv.slice(2);
for (const [name, r] of Object.entries(config.repos)) {
  if (only.length && !only.includes(name)) continue;
  const dir = repoDir(name);
  const head = git(dir, ['rev-parse', '--short', 'HEAD']).trim();
  if (r.pin && head !== r.pin) throw new Error(`${name}: HEAD ${head} != pin ${r.pin}`);
  const all = git(dir, ['ls-files']).split('\n').filter(Boolean);
  const inc = r.include.map((p) => new RegExp(p));
  const exc = (r.exclude ?? []).map((p) => new RegExp(p));
  const isTest = (f) => /(^|\/)(spec|test|tests|__tests__)\/|[._](test|spec)\.[^.]+$|(^|\/)test_[^/]+\.py$/.test(f);
  const files = all.filter((f) => inc.some((x) => x.test(f)) && !exc.some((x) => x.test(f))).sort();
  const subsets = r.subsets ?? { tune: config.subsetSize, holdout: config.subsetSize };
  const ranked = files.map((f) => [hash32(name + ':' + f), f]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const tests = ranked.filter(isTest), code = ranked.filter((f) => !isTest(f));
  let ti = 0, ci = 0;
  for (const [subset, size] of Object.entries(subsets)) {
    const n = Math.min(size, files.length - ti - ci);
    const nTest = Math.min(tests.length - ti, Math.round(n * (r.testShare ?? 0)));
    const pick = [...tests.slice(ti, ti + nTest), ...code.slice(ci, ci + n - nTest)].sort();
    ti += nTest; ci += n - nTest;
    const wd = workDir(name, subset);
    rmSync(wd, { recursive: true, force: true });
    for (const f of pick) { mkdirSync(join(wd, dirname(f)), { recursive: true }); cpSync(join(dir, f), join(wd, f)); }
    git(wd, ['init', '-q']); git(wd, ['add', '-A']);
    git(wd, ['-c', 'user.email=eval@jeviews', '-c', 'user.name=eval', 'commit', '-q', '-m', `${name}@${head} ${subset}`]);
    writeFileSync(join(evalDir(name), `${subset}.files.txt`), pick.join('\n') + '\n');
    console.log(`${name}/${subset}: ${pick.length} files (${nTest} test) from ${files.length} candidates @ ${head}`);
  }
}
