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
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');

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

// The three fatal/benign outcomes must each still be wired to the right exit.
ok(/indexed\)\s*\n\s*echo[^\n]*\n\s*exit 0/.test(workflow), 'indexed exits 0');
ok(/absent\)\s*\n\s*echo "::error[^\n]*\n\s*exit 1/.test(workflow), 'absent exits 1');
ok(/foreign\)\s*\n\s*echo "::error[^\n]*\n\s*exit 1/.test(workflow), 'foreign exits 1');
ok(/::warning::.*provenance/.test(workflow) && /exit 0 ;;/.test(workflow), 'lag warns and exits 0');

console.log(failures ? `\n[FAIL] ${failures} publish-verdict assertion(s) failed` : '\n[ok] publish-verdict: all assertions passed');
process.exit(failures ? 1 : 0);
