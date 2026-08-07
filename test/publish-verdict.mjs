// The publish workflow's post-publish verdict, tested against the shapes npm
// actually returns.
//
// FIELD INCIDENT 2026-08-07 (v1.61.0): the package published perfectly, with a
// SLSA provenance attestation, and the run still reported FAILURE claiming "the
// trusted-publishing path is broken". Cause: `npm view --json` renders an OIDC
// publish's `_npmUser` as the STRING "GitHub Actions <npm-oidc-no-reply@...>",
// but the classifier read `_npmUser.name` / `.email` as if it were an object.
// Both were undefined, so every provenance-indexing lag was misclassified as
// "foreign" and hard-failed — which meant the lag branch added in 1.58.0 to stop
// exactly this alarm was unreachable from the day it shipped.
//
// The script under test is EXTRACTED FROM THE WORKFLOW ITSELF rather than
// copied here: a copy would keep passing after the workflow drifted, which is
// the same class of defect as the bug it is meant to catch.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Strip CR: a CRLF working copy (git autocrlf on Windows) makes every
// `\)\n`-style pattern below silently miss, so the assertions would pass or
// fail for reasons unrelated to the workflow's content.
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8').replace(/\r/g, '');

let failures = 0;
const ok = (condition, label) => {
    console.log(`${condition ? '[ok]' : '[FAIL]'} ${label}`);
    if (!condition) failures++;
};

/** Pull the verdict classifier out of the workflow's inline `node -e` block. */
function extractVerdictScript() {
    const start = workflow.indexOf('VERDICT="$(printf \'%s\' "$LIVE" | node -e \'');
    if (start === -1) throw new Error('verdict classifier not found in publish.yml — did the step get renamed?');
    const body = workflow.slice(start);
    const scriptStart = body.indexOf("node -e '") + "node -e '".length;
    const scriptEnd = body.indexOf("\n            ' \"$NAME\" \"$GATE_VERSION\")");
    if (scriptEnd === -1) throw new Error('verdict classifier terminator not found — the inline script shape changed.');
    return body.slice(scriptStart, scriptEnd);
}

const script = extractVerdictScript();

function classify(meta) {
    return execFileSync(process.execPath, ['-e', script, 'klypix-mcp', '1.61.0'], {
        input: JSON.stringify(meta),
        encoding: 'utf8',
    }).trim();
}

const withProvenance = { dist: { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } };

// The exact metadata npm returned for the v1.61.0 publish that was misreported.
ok(classify({
    name: 'klypix-mcp',
    version: '1.61.0',
    _npmUser: 'GitHub Actions <npm-oidc-no-reply@github.com>',
}) === 'lag', 'a STRING _npmUser from an OIDC publish reads as lag, never foreign');

ok(classify({
    name: 'klypix-mcp',
    version: '1.61.0',
    _npmUser: { name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com' },
}) === 'lag', 'the object _npmUser shape still reads as lag');

ok(classify({
    name: 'klypix-mcp',
    version: '1.61.0',
    _npmUser: 'someone-else <human@example.com>',
}) === 'foreign', 'a genuinely foreign publisher still hard-fails');

ok(classify({
    name: 'klypix-mcp',
    version: '1.61.0',
    _npmUser: 'GitHub Actions <npm-oidc-no-reply@github.com>',
    ...withProvenance,
}) === 'indexed', 'provenance that lands after the poll window is a success, not a lag');

ok(classify({ name: 'klypix-mcp', version: '1.60.0' }) === 'absent', 'a different version on the registry means the publish did not land');
ok(classify({}) === 'absent', 'empty metadata means absent');

// The four outcomes must each still be wired to the right exit. Match the WHOLE
// branch (label → `;;`) and assert what it does, not how many lines it takes:
// the previous line-counting regexes failed the moment the absent branch gained
// the diagnostic echo that explains WHY a read-back looked absent, which is a
// test punishing an improvement it should have been indifferent to.
const branch = (label) => {
    const m = new RegExp(`\\n\\s*${label}\\)\\n([\\s\\S]*?);;`).exec(workflow);
    return m ? m[1] : null;
};
const exitsWith = (label, code) => {
    const body = branch(label);
    return Boolean(body) && new RegExp(`exit ${code}\\s*$`).test(body.trimEnd());
};
ok(exitsWith('indexed', 0), 'indexed exits 0');
ok(exitsWith('absent', 1) && /::error/.test(branch('absent')), 'absent errors and exits 1');
ok(exitsWith('foreign', 1) && /::error/.test(branch('foreign')), 'foreign errors and exits 1');
ok(/::warning::.*provenance/.test(workflow) && /exit 0 ;;/.test(workflow), 'lag warns and exits 0');

// The read-back must not depend on npm auth state (2026-08-07): this job carries
// no NODE_AUTH_TOKEN, `npm view` returned nothing under setup-node's .npmrc, and
// five releases in a row reported "the publish did not land" over a perfect
// artifact. The anonymous registry document is the auth-free source of truth.
const verifyStep = /Verify the published artifact carries provenance[\s\S]*?(?=\n      - name:|\n  [a-z-]+:|$)/.exec(workflow)?.[0] || '';
ok(/registry\.npmjs\.org\/\$\{NAME\}\/\$\{GATE_VERSION\}/.test(verifyStep),
    'the read-back queries the anonymous registry document');
// Comment lines are stripped first — the step deliberately NAMES `npm view` in
// prose to explain why it is not used, and an assertion that cannot tell code
// from commentary would force the explanation to be deleted.
// Both comment syntaxes: shell `#` and the `//` of the node scripts embedded in
// this step (one of which explains the `npm view --json` shape bug by name).
const verifyCode = verifyStep.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
ok(!/npm view/.test(verifyCode),
    'the read-back never routes through `npm view` (its auth state broke this gate for five releases)');
ok(/LAST_BODY/.test(verifyStep),
    'a hard failure prints the raw read-back so a broken reader is distinguishable from a failed publish');

console.log(failures ? `\n[FAIL] ${failures} publish-verdict assertion(s) failed` : '\n[ok] publish-verdict: all assertions passed');
process.exit(failures ? 1 : 0);
