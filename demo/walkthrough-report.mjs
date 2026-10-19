#!/usr/bin/env node
// Helper for demo/walkthrough.sh: print the parts of an eval run that a human
// actually reads - the scenario table, the receipts, and the transcript message
// a receipt points at.
import fs from 'node:fs';
import path from 'node:path';

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', Y = '\x1b[33m', C = '\x1b[36m';

const [cmd, ...rest] = process.argv.slice(2);

function scenarios(file) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`${D}skill: ${spec.skill_path}${R}`);
  console.log(`${D}model: ${spec.model_alias}  reps: ${spec.reps}  concurrency: ${spec.concurrency}${R}\n`);
  for (const s of spec.scenarios) {
    const kind = { positive: 'POSITIVE', negative: 'NEGATIVE', temptation: 'TEMPTATION' }[s.kind] ?? s.kind;
    console.log(`${B}${s.id}${R}  ${C}[${kind}]${R}`);
    console.log(`  prompt: ${s.prompt}`);
    for (const st of s.expected.steps) console.log(`    ${D}-${R} ${st.id}: ${st.description}`);
    console.log(`  ${D}rationale: ${s.rationale}${R}\n`);
  }
}

function loadRun(dir) {
  const findings = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
  return { dir, findings };
}

function receipts(dir) {
  const { findings } = loadRun(dir);
  const fails = findings.findings.filter(f => f.severity === 'high');
  const unsure = findings.findings.filter(f => f.severity !== 'high');
  console.log(`${B}FAILING (${fails.length})${R}`);
  for (const f of fails) {
    console.log(`  ${Y}${f.id}${R} ${f.scenario} / step ${f.step} -> ${f.label}`);
    console.log(`     ${D}expected:${R} ${f.description}`);
    const p = f.probabilities ?? {};
    console.log(`     ${D}p_done=${p.p_done} p_not_done=${p.p_not_done} p_unclear=${p.p_unclear} p_attempted_wrong=${p.p_attempted_wrong}${R}`);
    console.log(`     ${D}pointer:${R} turn ${f.pointer?.turn}, event ${f.pointer?.event_index}  (${f.evidence?.slice(0, 160)}...)`);
  }
  console.log(`\n${B}NEEDS A HUMAN (${unsure.length})${R}`);
  for (const f of unsure) console.log(`  ${f.id} ${f.scenario} / ${f.step} -> ${f.label} ${D}p_unclear=${f.probabilities?.p_unclear}${R}`);
}

function evidence(dir, findingId) {
  const { findings } = loadRun(dir);
  const f = findings.findings.find(x => x.id === findingId);
  if (!f) throw new Error(`no finding ${findingId}`);
  const sessions = fs.readdirSync(dir).filter(d => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, d, 'result.json'), 'utf8')).scenario === f.scenario; }
    catch { return false; }
  });
  for (const s of sessions) {
    const events = JSON.parse(fs.readFileSync(path.join(dir, s, 'events.json'), 'utf8'));
    const idx = f.pointer?.event_index ?? 0;
    const ev = events[idx] ?? events[events.length - 1];
    const last = [...events].reverse().find(e => e.kind === 'assistant_text');
    console.log(`${B}${s}${R}  (turn ${ev.turn}, event ${idx} of ${events.length})`);
    console.log(`${D}--- event ${idx} (${ev.kind}) ---${R}`);
    console.log(ev.text ?? JSON.stringify(ev));
    if (last && last !== ev) {
      console.log(`\n${D}--- the agent's final message ---${R}`);
      console.log(last.text);
    }
    console.log('');
  }
}

const cmds = { scenarios, receipts, evidence };
if (!cmds[cmd]) throw new Error(`usage: walkthrough-report.mjs scenarios|receipts|evidence ...`);
cmds[cmd](...rest);
