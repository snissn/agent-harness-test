import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const exec = promisify(execFile);
const root = process.cwd();
const evaluator = join(root, "tasks/python-text-report/1.0.0/evaluator/evaluate.py");
const state = join(root, "tasks/python-text-report/1.0.0/state");

async function score(variant: "broken" | "partial" | "good") {
  const workspace = await mkdtemp(join(tmpdir(), `text-report-${variant}-`));
  await cp(state, workspace, { recursive: true });
  if (variant === "partial") await writeFile(join(workspace, "text_report.py"), PARTIAL);
  if (variant === "good") await writeFile(join(workspace, "text_report.py"), GOOD);
  try {
    await exec("python3", [evaluator, workspace]);
    const evaluation = JSON.parse(await readFile(join(workspace, "evaluator.json"), "utf8"));
    const weights: Record<string, number> = { "summary-output": .6, "filters-and-order": .25, "input-errors": .15 };
    return { ...evaluation, duration_ms: 0, started_at: "", finished_at: "", score: evaluation.checks.reduce((sum: number, check: { id: string; score: number }) => sum + weights[check.id] * check.score, 0), passed: evaluation.checks.every((check: { id: string; passed: boolean }, index: number) => index !== 0 || check.passed) && evaluation.checks.reduce((sum: number, check: { id: string; score: number }) => sum + weights[check.id] * check.score, 0) >= .85 };
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

test("evaluator calibrates broken, partial, and known-good states deterministically", async () => {
  const broken = await score("broken");
  const partial = await score("partial");
  const good = await score("good");
  assert.deepEqual(broken.checks.map((c: { id: string }) => c.id), ["summary-output", "filters-and-order", "input-errors"]);
  assert.ok(broken.score < partial.score);
  assert.ok(partial.score < good.score);
  assert.equal(good.passed, true);
  assert.deepEqual(await Promise.all([score("good"), score("good"), score("good")]), [good, good, good]);
});

const PARTIAL = `import argparse,json,re\ndef summarize(text,limit,prefix=None):\n words=re.findall(r'[A-Za-z]+',text.lower()); counts={}\n for w in words: counts[w]=counts.get(w,0)+1\n return {'line_count':len([x for x in text.splitlines() if x.strip()]),'word_count':len(words),'top_words':[[w,n] for w,n in sorted(counts.items(),key=lambda x:(-x[1],x[0]))[:limit]]}\ndef main(argv=None):\n p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--limit',type=int,default=5);p.add_argument('--prefix');a=p.parse_args(argv)\n with open(a.input) as f: print(json.dumps(summarize(f.read(),a.limit,a.prefix),separators=(',',':')))\nif __name__=='__main__':main()\n`;
const GOOD = `import argparse,json,re\ndef summarize(text,limit,prefix=None):\n words=re.findall(r'[A-Za-z]+',text.lower()); words=[w for w in words if not prefix or w.startswith(prefix.lower())]; counts={}\n for w in words: counts[w]=counts.get(w,0)+1\n return {'line_count':len([x for x in text.splitlines() if x.strip()]),'word_count':len(words),'top_words':[[w,n] for w,n in sorted(counts.items(),key=lambda x:(-x[1],x[0]))[:limit]]}\ndef main(argv=None):\n p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--limit',type=int,default=5);p.add_argument('--prefix');a=p.parse_args(argv)\n if a.limit<1:p.error('--limit must be positive')\n try:\n  with open(a.input,encoding='utf-8') as f:text=f.read()\n except OSError as e:p.error(str(e))\n print(json.dumps(summarize(text,a.limit,a.prefix),separators=(',',':')))\nif __name__=='__main__':main()\n`;
