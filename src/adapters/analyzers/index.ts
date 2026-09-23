import type { StaticAnalyzer } from '../../review/ports.js';
import { createPythonAnalyzer } from './python.js';
import { createTypeScriptAnalyzer } from './typescript.js';

/** CLI が使う静的解析器。追加はこの配列に 1 行足す。 */
export function createAnalyzers(cwd: string): StaticAnalyzer[] {
  return [createPythonAnalyzer({ cwd }), createTypeScriptAnalyzer({ cwd })];
}
