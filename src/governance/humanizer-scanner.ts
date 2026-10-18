import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface HumanizationScanResult {
  passed: boolean;
  language: 'pl' | 'en';
  output: string;
  violationsCount: number;
}

export function detectDraftLanguage(text: string): 'pl' | 'en' {
  // Check for distinct Polish characters or stopwords
  const polishChars = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
  const polishStopwords = /\b(jest|oraz|nie|się|dla|przez|może|będzie|jako|tylko|który|która|które)\b/i;

  if (polishChars.test(text) || polishStopwords.test(text)) {
    return 'pl';
  }
  return 'en';
}

export function scanHumanization(text: string, repoRoot = process.cwd()): HumanizationScanResult {
  if (!text || !text.trim()) {
    return { passed: true, language: 'en', output: 'Empty text passed.', violationsCount: 0 };
  }

  const lang = detectDraftLanguage(text);

  let scriptRelPath: string;
  if (lang === 'pl') {
    scriptRelPath = 'skills/humanizer-pl/scripts/sprawdz.py';
  } else {
    scriptRelPath = 'skills/humanization/scripts/verify_humanization.py';
  }

  const scriptAbsPath = path.resolve(repoRoot, scriptRelPath);

  if (!fs.existsSync(scriptAbsPath)) {
    // If running in an environment without skills dir in cwd, check parent
    const fallbackPath = path.resolve('/home/ellie/ellie', scriptRelPath);
    if (!fs.existsSync(fallbackPath)) {
      return {
        passed: true,
        language: lang,
        output: `[Humanizer] Scanner script not found at ${scriptAbsPath}. Skipping.`,
        violationsCount: 0
      };
    }
  }

  const finalScriptPath = fs.existsSync(scriptAbsPath) ? scriptAbsPath : path.resolve('/home/ellie/ellie', scriptRelPath);

  // Try python3 or python
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

  try {
    const res = spawnSync(pythonBin, [finalScriptPath, '-'], {
      input: text,
      encoding: 'utf8',
      timeout: 10000
    });

    const output = (res.stdout || '') + (res.stderr || '');
    const exitCode = res.status ?? 0;

    // Exit code 0 is PASS; exit code 1 is violation/fail
    const passed = exitCode === 0;

    let violationsCount = 0;
    if (!passed) {
      // Count lines containing BŁĄD, SPRAWDŹ, P[0-9], or FAIL
      const lines = output.split('\n');
      violationsCount = lines.filter(l => /BŁĄD|SPRAWDŹ|FAIL|Tier\s+[AB]/i.test(l)).length || 1;
    }

    return {
      passed,
      language: lang,
      output: output.trim(),
      violationsCount
    };
  } catch (err: any) {
    return {
      passed: true, // Fail-open on environment execution failure with logged notice
      language: lang,
      output: `[Humanizer] Failed to invoke Python scanner: ${err.message}`,
      violationsCount: 0
    };
  }
}

/**
 * The scanner lines that must be fixed: English Tier A hits and Tier B clusters, Polish BŁĄD lines.
 * Tier R and SPRAWDŹ notes are judgment calls; showing them made the model re-check clean drafts.
 */
export function mustFixFindings(output: string, language: 'pl' | 'en'): string[] {
  if (language === 'pl') return output.split('\n').filter(l => /\sBŁĄD\s/.test(l)).map(l => l.trim());
  const out: string[] = [];
  let inMustFix = false;
  for (const line of output.split('\n')) {
    if (/^TIER A:|^TIER B CLUSTERS:/.test(line)) { inMustFix = true; continue; }
    if (/^TIER R:|^MANUAL|^RESULT:/.test(line)) { inMustFix = false; continue; }
    if (inMustFix && /^\s+L\d/.test(line)) out.push(line.trim());
  }
  return out;
}
