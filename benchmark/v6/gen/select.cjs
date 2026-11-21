'use strict';
// Seeded deterministic selection for v6 (dub apps/web). Adapted from v4 select.cjs.
// v6 picks by difficulty band so the set mixes easy, medium and hard questions.
// Inside a band the order is ascending sha256(SEED|repo|type|band|subject). Rejected subjects
// (../review/rejections.json) are skipped. Written before any Neorion output for dub existed.
// Usage: node select.cjs -> ../review/selection.json
const L = require('./lib.cjs');
const { fs, path } = L;
const repo = 'dub';
const rejPath = path.join(__dirname, '..', 'review', 'rejections.json');
const rejections = fs.existsSync(rejPath) ? JSON.parse(fs.readFileSync(rejPath, 'utf8')) : [];
const isRejected = (type, key) => rejections.some((r) => r.type === type && r.key === key);
const MATCHER_CONTEXT = /\.(includes|startsWith|endsWith|test|match|replace)$/;
const t3Structural = (x) => x.aliasFiles.length > 0 || x.barrelFiles.length > 0 || x.viaBarrelImporters.length > 0;
const t3GrepTrap = (x) => x.grepOnly.length > 0 || x.renameOnly.length > 0;
const t1Base = (x) => x.refOnlyRoutes.length === 0 && x.routes.length >= 1 && x.routes.length <= 15;
const t4Base = (x) => {
  const v = x.v4;
  if (/^\/api\/(cron|auth)\//.test(x.url)) return false; // background jobs and auth flows are not UI consumers
  if (!v || !v.requestFunctions.length || v.nonFunctionSites.length || x.anyAmbiguous || x.wildcardRisk.length) return false;
  if (x.occurrences.some((o) => MATCHER_CONTEXT.test(o.context))) return false;
  const reqFiles = new Set(v.requestFunctions.map((k) => k.split('#')[0]));
  // v6: the question is about UI consumers, so every answer file must be outside API handler code
  // and at least two answer files must be components (.tsx).
  if (v.files.some((f) => /(^|\/)api\//.test(f))) return false;
  if (v.files.filter((f) => f.endsWith('.tsx')).length < 2) return false;
  return v.files.some((f) => !reqFiles.has(f));
};
const BANDS = [
  { type: 'T1', band: 'easy', pool: 't1', subj: (x) => x.key, n: 1, f: (x) => t1Base(x) && x.routes.length <= 2 && x.minDepth >= 2 && x.maxDepth >= 3 && x.maxDepth <= 4 },
  { type: 'T1', band: 'medium', pool: 't1', subj: (x) => x.key, n: 1, f: (x) => t1Base(x) && x.routes.length >= 3 && x.routes.length <= 6 && x.minDepth >= 2 && x.maxDepth >= 4 && x.maxDepth <= 6 },
  { type: 'T1', band: 'hard', pool: 't1', subj: (x) => x.key, n: 1, f: (x) => t1Base(x) && x.routes.length >= 3 && x.maxDepth >= 7 },
  { type: 'T2', band: 'medium', pool: 't2', subj: (x) => x.route, n: 1, f: (x) => x.pageFile.startsWith('app/') && x.files.length >= 4 && x.files.length <= 6 && !x.notes.some((n) => n.startsWith('AMBIGUOUS')) },
  { type: 'T2', band: 'hard', pool: 't2', subj: (x) => x.route, n: 1, f: (x) => x.pageFile.startsWith('app/') && x.files.length >= 11 && !x.notes.some((n) => n.startsWith('AMBIGUOUS')) },
  // No hook in the computed pool has an alias, barrel or grep trap, so the hook band is the easy rename question.
  { type: 'T3', band: 'easy', pool: 't3', subj: (x) => x.key, n: 1, f: (x) => /^use[A-Z]/.test(x.name) && x.files.length >= 5 && x.files.length <= 12 && x.grepOnlyTests.length === 0 },
  { type: 'T3', band: 'hard', pool: 't3', subj: (x) => x.key, n: 1, f: (x) => !/^use[A-Z]/.test(x.name) && x.files.length >= 4 && x.files.length <= 15 && x.grepOnlyTests.length === 0 && t3Structural(x) && t3GrepTrap(x) },
  { type: 'T4', band: 'medium', pool: 't4', subj: (x) => x.url, n: 1, f: (x) => t4Base(x) && x.v4.files.length >= 3 && x.v4.files.length <= 4 },
  { type: 'T4', band: 'hard', pool: 't4', subj: (x) => x.url, n: 1, f: (x) => t4Base(x) && x.v4.files.length >= 5 && x.v4.files.length <= 12 },
];
const cands = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', `${repo}.candidates.json`), 'utf8'));
const usedNames = new Set();
const usedAnswers = new Set();
const answerOf = (type, x) => (type === 'T1' ? x.routes : type === 'T4' ? x.v4.files : x.files);
const selection = [];
for (const b of BANDS) {
  const pool = cands[b.pool].filter(b.f)
    .map((x) => ({ x, subject: b.subj(x), order: L.seededKey(repo, b.type, b.band, b.subj(x)) }))
    .sort((a, c) => (a.order < c.order ? -1 : 1));
  let picked = 0;
  for (const c of pool) {
    if (picked >= b.n) break;
    const nm = c.subject.split('#').pop();
    const sig = b.type + JSON.stringify(answerOf(b.type, c.x));
    let reason = null;
    if (isRejected(b.type, c.subject)) reason = 'rejected in review';
    else if (usedNames.has(nm)) reason = 'subject already used';
    else if (usedAnswers.has(sig)) reason = 'same answer set as an earlier pick';
    if (reason) { selection.push({ type: b.type, band: b.band, skipped: { subject: c.subject, reason } }); continue; }
    usedNames.add(nm); usedAnswers.add(sig);
    selection.push({ repo, type: b.type, band: b.band, subject: c.subject, order: c.order, rankInPool: pool.indexOf(c), poolSize: pool.length, data: c.x });
    picked++;
  }
  if (picked < b.n) throw new Error(`not enough ${b.type}/${b.band}`);
}
fs.mkdirSync(path.dirname(rejPath), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'review', 'selection.json'), JSON.stringify(selection, null, 1));
for (const s of selection) {
  if (s.skipped) { console.log(`  skip ${s.type}/${s.band} ${s.skipped.subject}: ${s.skipped.reason}`); continue; }
  const ans = answerOf(s.type, s.data);
  console.log(`${s.type}/${s.band} #${s.rankInPool}/${s.poolSize} ${s.subject} -> ${ans.length}: ${ans.join(', ')}`);
}
