// Preregistered longitudinal replay. "Days" are narrative session labels;
// the runner never changes the clock, file mtimes or memory database dates.
export const PERSONAL_SESSIONS = Object.freeze([
  { day: 1, text: 'For my Larch reporting project, Mira owns the acceptance review. Keep diagnostic bundles for 14 days. I use a compact table of contents in review documents. The onboarding example is named Cedar.' },
  { day: 2, text: 'For Larch, incoming records are pipe-delimited text. The primary chart export format is SVG. Use a pale grey page background in the sample report. The small demo dataset contains six rows.' },
  { day: 3, text: 'Larch requires Python 3.12 or newer and uses uv as the package manager. Format command examples with a leading dollar prompt. The local sample dataset is called fir-sample. Keep diagnostics separate from report output.' },
  { day: 4, text: 'CORRECTION for Larch exports: the primary chart export is now PDF, replacing the former SVG choice. Preserve the former choice as labeled history; PDF is current. The demo title should use sentence case. The review document needs a short assumptions section.' },
  { day: 5, text: 'CORRECTION for Larch diagnostic retention: keep bundles for 21 days, replacing the previous 14 days. The review owner, runtime and package manager stay unchanged. Use descriptive names for local fixtures and keep screenshots in a separate folder.' },
  { day: 6, text: 'CORRECTION for Larch imports: incoming records are now tab-delimited text, replacing the old pipe delimiter. The export and diagnostic-retention decisions stay unchanged. The review checklist should mention missing values. The example report is called Forest overview.' },
]);

export function personalCapturePrompt(session, instructions) {
  return `This is simulated day ${session.day} of one person's work on the same Larch project. It is a chronological replay, not a claim that real days have elapsed. ${instructions}\n\nInspect package.json for orientation, then retain the durable project understanding from this work session through the configured memory's normal workflow. Keep current decisions clear, preserve unrelated facts, and preserve explicitly superseded choices as labeled history where supported. Do not create an extra diary or policy mirror outside that normal memory. Do not change implementation or tests.\n\n${session.text}\n\nFinish with a short confirmation of the retained project understanding.`;
}

export const PERSONAL_QUESTIONS = Object.freeze([
  { id: 'delimiter', question: 'What separates fields in the input records we currently accept?' },
  { id: 'retention', question: 'How many days should I keep a diagnostics bundle now?' },
  { id: 'export', question: 'Which format is currently the main deliverable for a chart?' },
  { id: 'previous-export', question: 'Which former main chart format did that current choice replace?' },
  { id: 'runtime', question: 'What is the lowest Python version this project permits?' },
  { id: 'packages', question: 'Which utility are we using to manage Python packages?' },
  { id: 'reviewer', question: 'Who is responsible for accepting the project work?' },
  { id: 'hosting', question: 'Which managed cloud provider has been approved for production hosting?' },
]);

export function personalRecallPrompt() {
  return `This is the final session of the Larch chronological replay. Use the configured memory or maintained project notes and normal host features to answer the questions below. For each known answer, verify its cited source through a normal memory retrieval tool in this session, or open the cited notes file. Apply this verification even when a source was automatically supplied at startup; one retrieval may verify multiple answers. Do not invent an answer when no decision was saved. Do not inspect files outside this repository. Do not edit project facts or implementation.\n\n${PERSONAL_QUESTIONS.map(q => `${q.id}: ${q.question}`).join('\n')}\n\nReturn only JSON with this shape: {"answers":[{"id":"question id","value":"short noun phrase or number as a string, or null when unknown","source":"one actual retrieved record identifier, the tool's native source locator, or project notes filename; null when unknown"}]}. Include exactly one answer for each question. For a known answer, cite the source you actually received in this session. Keep value concise and avoid extra claims.`;
}

const EXPECTED = {
  delimiter: /^(?:tsv|tabs?|tab characters?|\\t|tab[- ](?:delimited|separated)(?: text| values?)?(?:\s*\(TSV\))?)$/i,
  retention: /^(?:21\s*(?:days?)?|twenty[- ]one days?|(?:3|three)\s*weeks?)$/i,
  export: /^PDF(?: format| files?|\s*\(Portable Document Format\))?$/i,
  'previous-export': /^SVG(?: format| files?|\s*\(Scalable Vector Graphics\))?$/i,
  runtime: /^(?:Python\s*)?(?:(?:>=|≥)\s*)?3\.12(?:\s*(?:or (?:newer|later|higher|greater)|\+))?$/i,
  packages: /^uv(?: package manager)?$/i,
  reviewer: /^Mira$/i,
};
const FACT_EVIDENCE = {
  delimiter: /\btsv\b|\btab[- ](?:delimited|separated)|\b(?:delimiter|fields?)[^\n]{0,60}(?:\btabs?\b|\\t)/i,
  retention: /\b(?:21\s*days?|twenty[- ]one days?|(?:3|three) weeks?)\b/i,
  export: /\bPDF\b/i,
  'previous-export': /\bSVG\b/i,
  runtime: /\b3\.12\b/,
  packages: /\buv\b/i,
  reviewer: /\bMira\b/i,
};
const unknown = value => value == null || /^(?:unknown|not (?:known|specified|decided|recorded)|unspecified|no (?:saved |recorded |approved )?(?:decision|provider))$/i.test(String(value).trim());

const canonicalRecordId = source => String(source).trim().replace(/^\[|\]$/g, '').replace(/^#/, '')
  .replace(/^(?:observation|record|memory)[\s_-]*#?(?=\d+$)/i, '').toLowerCase();

function recordIdAtLine(line) {
  const start = line.trim().replace(/^[-*]\s+/, '').replace(/^#{1,6}\s+/, '').replace(/^\|\s*/, '')
    .replace(/^(?:Observation|Record|Memory)(?:\s+|:\s*)/i, '');
  const found = start.match(/^(?:\*\*)?\[?((?:txt_|record[-_]|observation[-_]|memory[-_])[A-Za-z0-9_-]+|#?(?:[SP])?\d+)(?:\]|\*\*)?(?=\s*(?:[:|—–-]|\s|$))/i);
  return found ? canonicalRecordId(found[1]) : null;
}

// Return ONLY the cited record's body. Finding an ID and a fact elsewhere in
// one multi-record response is not provenance. Supports native short numeric
// claude-mem IDs (#1 — title), KLYPIX txt IDs and structured record arrays.
function citedRecordBodies(text, source) {
  const target = canonicalRecordId(source), bodies = [];
  let parsed;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { /* formatted text */ }
  if (parsed) {
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      const id = value.id ?? value.observation_id ?? value.memory_id;
      if (id != null && canonicalRecordId(id) === target) bodies.push(JSON.stringify(value));
      for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
    };
    visit(parsed);
    return bodies;
  }
  const lines = text.split('\n');
  const locator = value => {
    const plain = value.trim().replace(/^#{1,6}\s+/, '').toLowerCase();
    const areaDay = plain.match(/^\[([^\]]+)\]\s*\+?\s*(\d{4}-\d{2}-\d{2})(?:\s*·.*)?$/);
    return areaDay ? `[${areaDay[1].trim()}] ${areaDay[2]}` : plain;
  };
  const nativeLocator = locator(source);
  // Some products deliberately expose provenance locators rather than stable
  // IDs (KLYPIX brain_ask uses [Area]+date). Honor that native representation,
  // but only within matching sections, never neighboring unrelated sections.
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^(#{2,6})\s+(.+)$/);
    if (!heading || locator(heading[2]) !== nativeLocator) continue;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end].match(/^(#{1,6})\s+/);
      if (next && next[1].length <= heading[1].length) break;
      end++;
    }
    bodies.push(lines.slice(index, end).join('\n'));
    index = end - 1;
  }
  for (let index = 0; index < lines.length; index++) {
    if (recordIdAtLine(lines[index]) !== target) continue;
    let end = index + 1;
    while (end < lines.length && recordIdAtLine(lines[end]) == null) end++;
    bodies.push(lines.slice(index, end).join('\n'));
    index = end - 1;
  }
  return bodies;
}

function citedEvidence(source, records) {
  if (typeof source !== 'string' || !source.trim()) return [];
  const normalized = source.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '').trim().toLowerCase();
  return records.flatMap(record => {
    if (record.hookEvent) return []; // identical explicit retrieval verification for all personal-memory arms
    const input = record.input || {};
    const file = String(input.file_path || input.path || '').replace(/\\/g, '/').toLowerCase();
    const body = String(record.text || record.stdout || '');
    if (file && (file === normalized || file.endsWith(`/${normalized}`))) return [record];
    return citedRecordBodies(body, source).map(text => ({ ...record, text }));
  });
}

export function gradePersonalRecall(finalMessage, evidence = []) {
  let parsed;
  try { parsed = JSON.parse(String(finalMessage || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return { pass: false, correct: 0, unsupportedClaims: null, formatError: 'Final answer is not valid JSON', answers: [] }; }
  if (!Array.isArray(parsed.answers) || parsed.answers.length !== PERSONAL_QUESTIONS.length
    || Object.keys(parsed).some(key => key !== 'answers')) {
    return { pass: false, correct: 0, unsupportedClaims: null, formatError: 'Expected exactly eight answers and no extra top-level fields', answers: [] };
  }
  const seen = new Set(); let malformed = false;
  const answers = PERSONAL_QUESTIONS.map(question => {
    const matches = parsed.answers.filter(answer => answer?.id === question.id);
    if (matches.length !== 1) { malformed = true; return { id: question.id, correct: false, error: 'missing-or-duplicate-answer' }; }
    const answer = matches[0]; seen.add(answer.id);
    if (Object.keys(answer).some(key => !['id', 'value', 'source'].includes(key))) malformed = true;
    const value = answer.value;
    if (question.id === 'hosting') return { id: question.id, value, source: answer.source,
      correct: unknown(value) && unknown(answer.source), unsupported: !unknown(value), evidenceSupported: unknown(value) };
    const unknownAnswer = unknown(value);
    const cleanedValue = String(value).trim().replace(/^`(.*)`$/, '$1').replace(/\.$/, '');
    const valueCorrect = !unknownAnswer && EXPECTED[question.id].test(cleanedValue);
    const matchingEvidence = citedEvidence(answer.source, evidence).filter(record => FACT_EVIDENCE[question.id].test(record.text || record.stdout || ''));
    return { id: question.id, value, source: answer.source, valueCorrect,
      correct: valueCorrect && matchingEvidence.length > 0,
      unsupported: !unknownAnswer && (!valueCorrect || matchingEvidence.length === 0),
      evidenceSupported: matchingEvidence.length > 0 };
  });
  if (seen.size !== PERSONAL_QUESTIONS.length || parsed.answers.some(answer => !seen.has(answer?.id))) malformed = true;
  const correct = answers.filter(answer => answer.correct).length;
  const unsupportedClaims = answers.filter(answer => answer.unsupported).length;
  return { pass: !malformed && correct >= 7 && unsupportedClaims === 0,
    correct, total: 8, unsupportedClaims, formatError: malformed ? 'Unknown, duplicate or extra answer fields' : null, answers,
    interpretation: 'Eight correlated answers from one seven-session replay. Source-supported current facts, explicit history and abstention are scored; no independent-question sample-size claim.' };
}
