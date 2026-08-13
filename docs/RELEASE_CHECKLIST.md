# Release checklist — klypix-mcp

How a version of `klypix-mcp` gets to npm, what the pipeline proves before it lets that
happen, and what to do when a gate goes red.

Until 2026-07-30 `.github/workflows/publish.yml` ran **no tests**: a published GitHub
Release went straight to `npm publish`. It now **fails closed** — the `publish` job
declares `needs: gate`, so a red gate means npm never sees a tarball.

---

## 1. Before you tag

| # | Step | Command |
|---|------|---------|
| 1 | Working tree clean, on the source commit | `git status --short` |
| 2 | Dependencies match the lockfile exactly | `npm ci` |
| 3 | Full suite green | `npm test` |
| 4 | Bump the version and commit all source changes | edit `package.json` → commit |
| 5 | Record the immutable source target | `SOURCE_COMMIT=$(git rev-parse HEAD)` |
| 6 | Add the fixed, corroborated evidence bundle in one new commit | `.release-evidence/v<version>/` only |
| 7 | Verify that committed bundle against the source target | command below |
| 8 | Sanity-check what will ship | `npm pack --dry-run` |

The release tag does **not** point at the source commit. It points at the next,
one-parent **evidence commit**. That commit may add only regular `100644` files under:

```text
.release-evidence/v<package-version>/
├── expectations.json
├── receipt.json
└── artifacts/...
```

`expectations.json` freezes the independently reviewed `artifacts` and `publicClaims`.
`receipt.json` must bind those expectations to validated, peer-corroborated schema-v2
result evidence for `SOURCE_COMMIT`. A unique single-run result is not publishable.
After committing the bundle, the working tree must be clean and this exact command
must pass:

```bash
VERSION="$(node -p "require('./package.json').version")"
SOURCE_COMMIT="$(git rev-parse HEAD^)"
node scripts/verify-release-evidence.mjs \
  --project . \
  --receipt ".release-evidence/v${VERSION}/receipt.json" \
  --expectations ".release-evidence/v${VERSION}/expectations.json" \
  --package "$(node -p "require('./package.json').name")" \
  --version "$VERSION" \
  --git-commit "$SOURCE_COMMIT" \
  --require-corroborated
```

The verifier rejects a dirty tree, a self-targeting receipt, an abbreviated/ref target,
an evidence path outside the fixed bundle, a rename/delete/mode change, an untracked
bundle file, any non-evidence change between `HEAD^` and `HEAD`, and missing or
conflicting peer corroboration.

Rules that the pipeline will enforce anyway, so save yourself a red run:

- **The tag must be `v<version>`** and must match `package.json` exactly (`v1.44.0` ⇢ `1.44.0`).
- **The tag must point at the evidence commit.** That commit must have exactly one
  parent, and the source target is always `HEAD^`.
- **npm versions are immutable.** A version already on the registry can never be
  republished. If you need to re-cut, bump the patch.
- **Anything the README tells a user to open must be inside `package.json` `files`.**
  The `examples/` canvases were excluded from the tarball for several releases while the
  README instructed users to run
  `npx klypix-read node_modules/klypix-mcp/examples/showcase-brain.klypix`. That command
  failed on every fresh install. The tarball gate now makes that impossible to ship again.

## 2. Cut the release

```bash
git status --short                     # must print nothing
git show --stat --oneline HEAD         # evidence-only commit
git tag v<version> HEAD
git push origin v<version>
gh release create v<version> --title "v<version> — <headline>" --notes "..."
```

Publishing the GitHub Release fires the normal workflow; `workflow_dispatch` is the
explicit manual rerun path. Both bind the exact release tag — see Gate 5.

## 3. Watch the run

```bash
gh run watch          # or: gh run list --workflow=publish.yml
```

Three jobs, in order:

```
bind  (contents: read; no checkout/code)  →  gate  (contents: read only)  →  publish  (id-token: write)
immutable event SHA                       evidence before dependencies      OIDC trusted publishing
                                          tests · tarball · CLI smoke
```

The bind job captures canonical `github.sha` without checking out or running repository
code. Both later jobs consume that immutable output directly, so dependency or test code
cannot select a different SHA for publication. The permission split is deliberate: the
gate executes third-party code (`npm ci`,
`npm test`, installing the tarball) and is **not** given `id-token: write`, so a
compromised dependency in the test path cannot mint an npm publishing token.

---

## 4. The gates — what each one proves, and what to do when it fails

### Gate 1 · Trigger and immutable identity binding
**Proves** the run came from `release: published` or `workflow_dispatch` — never a
pull request — and binds the canonical 40-character event SHA before checkout or any
package/repository execution. The gate then checks out that exact SHA and proves the
tag, checkout, evidence commit, and direct source parent before `npm ci`.
**If it fails:** someone added a trigger to `publish.yml`. Remove it. A fork PR must
never be able to reach the job that mints an OIDC token.

### Gate 2 · `npm ci` (lockfile enforced)
**Proves** `package.json` and `package-lock.json` agree, and that the declared
dependency tree actually installs. Unlike the publish job, optional dependencies are
**not** omitted here: `@huggingface/transformers` being present is the *harder* case for
`test/semantic-gate.mjs`, which exists to prove the hook never loads the embedding model
out of an ambient `node_modules`.
**If it fails:** run `npm install` locally, commit the updated lockfile, re-tag. Do not
"fix" it by switching the workflow to `npm install` — that would delete the guarantee.

### Gate 3 · Test-chain integrity
**Proves** the `npm pretest` + `npm test` chain still runs the slow conformance suite,
the CLI argument contract suite, the adversarial publication-evidence suites, the
workflow security/topology regression, and the publish-verdict regression. In particular,
`test/evidence-publication-gate.mjs` attacks forged hashes, missing/empty peer bindings,
path and mode tricks, non-evidence diffs, and mismatched claims; `test/cli-args.mjs`
exercises the actual CLI entry points. `test/release-evidence-cli.mjs` builds a real
two-commit Git fixture and proves the executable verifier accepts only the closed,
corroborated direct-parent bundle. `test/publish-workflow.mjs` pins the pre-execution
identity binding, OIDC job's permissions, immutable action/runtime references, ordering, no-install/no-lifecycle
policy, evidence invocation, and tarball exclusion.
**If it fails:** re-add the missing suite to `scripts.pretest` or `scripts.test`. If you
genuinely intend to
move a suite to its own step, edit the required-list in the workflow in the same commit,
deliberately.

### Gate 4 · `npm test` (full suite, conformance included)
**Proves** every suite in the chain passes on a clean checkout. The conformance suite is
run **inside** this chain — `test/conformance.mjs` spawns `klypix-mcp conformance --json`
and asserts every published check — so it is not duplicated as a separate step; Gate 3
guarantees it cannot silently leave the chain.
**If it fails:** read the failing suite name in the log and fix the code. Never publish
past a red suite by dispatching manually — the manual path runs the same gate.

### Gate 5 · Version validation
**Proves** four things:
1. both a published Release and a manual dispatch resolve to the exact tag `v<version>`;
2. that tag matches `package.json` and points at this exact checkout;
3. the tagged checkout is a one-parent evidence commit, never a merge commit;
4. its sole parent (`HEAD^`) is the source target the evidence must bind.

**If it fails:**
- *"Tag X does not match package.json version Y"* — bump the version or re-tag. Never
  publish a mismatched pair; the tarball and the git history would disagree forever.
- *"No tag v<version> exists"* — you dispatched from a branch. Tag first.
- *"must be one evidence commit with exactly one parent"* — rebuild the evidence-only
  commit directly on top of the intended source commit; do not tag a merge or source commit.

### Gate 6 · Corroborated release evidence
**Proves** the checked-out tag is exactly one evidence-only commit after the source
target and that `.release-evidence/v<version>/` is a closed, committed bundle. The
workflow invokes `scripts/verify-release-evidence.mjs` with the full `HEAD^` object ID,
the exact receipt and expectations paths, the package identity/version, and
`--require-corroborated`.

The verifier re-hashes the committed receipt and artifacts, matches every public claim
to the independently reviewed expectations, requires a distinct valid peer run, rejects
conflicting/incomparable evidence, and fails if `HEAD^..HEAD` contains anything except
the declared evidence files as regular `100644` additions. Evidence cannot authorize
the same commit that contains it.

**If it fails:** do not edit the receipt until it passes. Fix or rerun the underlying
evaluation, obtain genuine peer corroboration, regenerate the expectations/receipt,
and create a new evidence-only commit. If any source changed, that is a new source
target: rebuild all evidence against it and bump/re-cut as appropriate.

### Gate 7 · Tarball contents
**Proves**, from `npm pack --dry-run --json` — i.e. from what will actually ship, not
from what `package.json` intends:
- every command in `bin` is in the tarball (otherwise `npm i -g` creates a shim pointing
  at nothing);
- `main` and every string entry in `exports` resolve;
- every literal path in `files` is present (catches an `.npmignore` slip) and every
  declared **directory** is non-empty (catches a silently emptied directory);
- **every `examples/…` path the README names is inside the tarball** — the regression
  gate for the excluded-examples bug;
- nothing forbidden shipped (`node_modules/`, `.git/`, `.env*`, `*.klypix-bak`,
  `.impeccable/`, `.release-evidence/`). The evidence authorizes publication but is
  deliberately excluded from the consumer package.

**If it fails:**
- `MISSING <path>` — add the directory or file to `package.json` `files`, or stop
  referencing it from the README. Both are legitimate; pick one.
- `EMPTY <dir>/` — the directory is declared but shipped nothing.
- `VACUOUS` — the README no longer references any `examples/` path, so the assertion
  checks nothing. Restore the references, or delete that assertion in the workflow
  deliberately. It fails loudly rather than passing silently on purpose.
- `FORBIDDEN <path>` — something private or huge is about to be published. Fix
  `files` / `.npmignore` before doing anything else.

### Gate 8 · CLI smoke test
Everything above tests the **working tree**. This step tests what a **user receives**:
`npm pack`, install that tarball into a throwaway directory with a throwaway `HOME`, and
drive the installed binaries.

**Proves:**
1. `klypix-mcp --help` runs from the packed install and prints the verb list;
2. `klypix-link --check` in an empty fixture **exits non-zero** and creates **zero
   files** (tree hash byte-identical before and after);
3. the dispatcher form `klypix-mcp link --check` agrees with the standalone bin on exit
   code and on writing nothing;
4. the README's documented example path resolves inside `node_modules/klypix-mcp`.

Assertion 2 is the regression gate for the P0 fixed on 2026-07-30: the standalone
`klypix-link` bin parsed `process.argv.slice(3)`, correct only behind the
`klypix-mcp link` dispatcher. Run as its own published bin the `--check` flag was
**dropped** — it wrote all 14 managed project files and exited 0, so anyone wiring
`klypix-link --check` into CI got a gate that rewrote their working tree and passed
unconditionally. The same slice also swallowed a positional directory, so
`klypix-link <dir>` wrote into the *current* directory instead.

**If it fails:** do not publish. A failure here means the tarball is broken in a way the
working tree is not — usually a file that exists locally but is not in `files`, or an
argv regression. Reproduce locally with:

```bash
npm pack --pack-destination /tmp/tgz
mkdir -p /tmp/smoke && cd /tmp/smoke && npm init -y
npm install --no-save --ignore-scripts --omit=optional /tmp/tgz/klypix-mcp-<version>.tgz
./node_modules/.bin/klypix-mcp --help
mkdir -p /tmp/fixture && cd /tmp/fixture && ../smoke/node_modules/.bin/klypix-link --check ; echo "exit=$?"
ls -A            # must be empty
```

### Publish · OIDC trusted publishing
Tokenless. No `NPM_TOKEN`, no secret. npm trusts this exact repository + workflow
filename (npmjs.com → package → Settings → Trusted Publisher).

Requirements, all already satisfied by the workflow: npm CLI ≥ 11.5.1, Node ≥ 22.14.0,
`id-token: write`, a GitHub-hosted runner, and the Trusted Publisher configured on npm
before the first run.

The privileged job checks out the exact pre-execution-bound evidence SHA directly,
proves that identity immediately, uses commit-pinned official checkout/setup actions with an
exact Node toolchain and package-manager caching disabled, and asserts the bundled
npm version is new enough. It deliberately runs no dependency install, build, test,
or repository lifecycle script while `id-token: write` is available; all untrusted
execution remains in the unprivileged gate job.

**Provenance is generated automatically** on this path — do **not** add `--provenance`.
Verified against the registry: the published `klypix-mcp@1.43.1` carries
`dist.attestations.provenance` with predicate type `https://slsa.dev/provenance/v1`, and
`_npmUser` is `GitHub Actions <npm-oidc-no-reply@github.com>`. A post-publish step now
reads the artifact back and **fails the run** if the attestation is ever missing, so a
silent loss of provenance surfaces immediately instead of being discovered by a user.

**If the publish step fails:** nothing was published — fix and re-run. **If the
provenance verification fails:** the package *is* published (npm versions are
immutable). Do not attempt to unpublish; investigate the trusted-publisher config, then
ship a patch release once the path is fixed. **If the verification step only warns**
("could not read the package back"), the publish succeeded and the registry was slow to
index; confirm by hand:

If the privileged job reports *"already published on npm with different integrity"*,
bump the version. An idempotent rerun skips `npm publish` only when the immutable registry
tarball has the exact integrity produced by the gate-cleared checkout. A mismatch or a
transport failure is a hard stop; neither can waive the integrity comparison.

```bash
npm view klypix-mcp@<version> --json | grep -A3 attestations
```

---

## 5. After the run

1. `npm view klypix-mcp version` shows the new version.
2. Install it clean somewhere neutral and run `klypix-mcp --help`.
3. `npx klypix-mcp doctor` in a linked project — it should report aligned.
4. Machines pick the new build up through the auto-propagation path; a fresh
   `npx klypix-mcp install` forces it.

## 6. Manual re-runs

`workflow_dispatch` exists for re-running a release whose publish or provenance-readback
step failed for an infrastructure reason. It runs **the same gate** — there is no bypass,
by design. It refuses untagged code; if the version is already on the registry, it proceeds
only when the immutable tarball integrity exactly matches the gate-cleared checkout.

## 7. What this pipeline deliberately does not do

State these plainly rather than assuming them away:

- **It does not run on pull requests.** There is no PR-time CI for this repo, so a
  contributor's first signal is the release gate. Adding a separate `ci.yml` that runs
  `npm ci && npm test` on `push`/`pull_request` is the obvious next step; it was left out
  here to keep the publish path's behaviour a single, reviewable change.
- **It does not test on Windows.** The gate runs on `ubuntu-latest` only, while a large
  share of users — and the known `EPERM`/rename flakes — are on Windows. A matrix run is
  a follow-up.
- **It does not verify, end to end, the flat bundle produced from the packed tarball.**
  The source installer/flat runtime and the packed CLI are gated separately, so their
  composition still relies on the installer and tarball-content assertions agreeing.
- **It cannot unpublish.** Every gate exists because the one thing that cannot be undone
  is a bad publish.

---

## Historical issue — post-publish provenance false-negatives

**Found on the first real run of this pipeline (v1.44.0, 2026-07-30).**

The run showed a red ❌ but **the publish succeeded and the artifact carries
provenance.** Evidence from that run's log:

```
npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=2291390085
+ klypix-mcp@1.44.0
```

`npm view klypix-mcp version` → `1.44.0`. The gate job passed. Only the final
**"Verify the published artifact carries provenance"** step failed.

**Cause:** that step reads the package back from the registry ~2s after publish.
Its retry loop breaks as soon as the response is non-empty — but before indexing
completes npm can return a non-empty body that is *not the package*. It parses to
`undefined@undefined`, the `.dist.attestations.provenance` lookup is undefined,
and the step reports "NO provenance" on an artifact that has it.

**Current fix:** the read-back now polls the anonymous registry document, requires the
exact package name, version and provenance object before declaring success, distinguishes
an absent version from OIDC provenance-indexing lag, and relies on the next release gate
to re-verify any lagged predecessor. Keep the multi-line `run:` block covered by
`test/publish-workflow.mjs`; careless YAML replacement can still corrupt the mapping.

If a future read-back failure appears, inspect the classified outcome and the publish
step's `+ <name>@<version>` / Sigstore lines before reacting; an absent package, a foreign
publisher and OIDC indexing lag are now reported separately.
