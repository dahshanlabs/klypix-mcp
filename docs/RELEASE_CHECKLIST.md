# Release checklist — klypix-mcp

How a version of `klypix-mcp` gets to npm, what the pipeline proves before it lets that
happen, and what to do when a gate goes red.

Until 2026-07-30 `.github/workflows/publish.yml` ran **no tests**: a published GitHub
Release went straight to `npm publish`. It now **fails closed** — the `publish` job
declares `needs: gate`, so a red gate means npm never sees a tarball.

---

## 1. Before you tag (local, ~5 minutes)

| # | Step | Command |
|---|------|---------|
| 1 | Working tree clean, on the release commit | `git status --short` |
| 2 | Dependencies match the lockfile exactly | `npm ci` |
| 3 | Full suite green | `npm test` |
| 4 | Bump the version | edit `package.json` → commit |
| 5 | Sanity-check what will ship | `npm pack --dry-run` |

Rules that the pipeline will enforce anyway, so save yourself a red run:

- **The tag must be `v<version>`** and must match `package.json` exactly (`v1.44.0` ⇢ `1.44.0`).
- **npm versions are immutable.** A version already on the registry can never be
  republished. If you need to re-cut, bump the patch.
- **Anything the README tells a user to open must be inside `package.json` `files`.**
  The `examples/` canvases were excluded from the tarball for several releases while the
  README instructed users to run
  `npx klypix-read node_modules/klypix-mcp/examples/showcase-brain.klypix`. That command
  failed on every fresh install. Gate 6 now makes that impossible to ship again.

## 2. Cut the release

```bash
git tag v<version>
git push origin v<version>
gh release create v<version> --title "v<version> — <headline>" --notes "..."
```

Publishing the GitHub Release fires the workflow. Nothing else does — see §5.

## 3. Watch the run

```bash
gh run watch          # or: gh run list --workflow=publish.yml
```

Two jobs, in order:

```
gate  (contents: read only)          →   publish  (id-token: write)
tests · tarball contents · CLI smoke      OIDC trusted publishing
```

The permission split is deliberate: the gate executes third-party code (`npm ci`,
`npm test`, installing the tarball) and is **not** given `id-token: write`, so a
compromised dependency in the test path cannot mint an npm publishing token.

---

## 4. The gates — what each one proves, and what to do when it fails

### Gate 1 · Trigger assertion
**Proves** the run came from `release: published` or `workflow_dispatch` — never a
pull request.
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
**Proves** the `npm test` script still runs `test/conformance.mjs` and
`test/cli-args.mjs`. These are the two most likely to be quietly dropped — conformance
is slow, and cli-args is new.
**If it fails:** re-add the missing suite to `scripts.test`. If you genuinely intend to
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
**Proves** three things:
1. the tag matches `package.json`'s version (release event, or a tag ref);
2. a **manual dispatch from a branch** is still standing on a real tag `v<version>` that
   points at *this exact commit* — a dispatch can never publish untagged code;
3. the version is not already on npm.

**If it fails:**
- *"Tag X does not match package.json version Y"* — bump the version or re-tag. Never
  publish a mismatched pair; the tarball and the git history would disagree forever.
- *"No tag v<version> exists"* — you dispatched from a branch. Tag first.
- *"already published on npm"* — bump the version. This check is stricter than the old
  behaviour on purpose: it turns an unreadable failure deep inside `npm publish` into a
  one-line message. The one case it costs you: re-dispatching a run for a version that
  *did* reach the registry is now blocked at the gate instead of at publish. That is the
  same outcome, reported earlier.
- Network flake reading the registry is **not** treated as "not published" — only a
  definitive non-empty answer blocks.

### Gate 6 · Tarball contents
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
  `.impeccable/`).

**If it fails:**
- `MISSING <path>` — add the directory or file to `package.json` `files`, or stop
  referencing it from the README. Both are legitimate; pick one.
- `EMPTY <dir>/` — the directory is declared but shipped nothing.
- `VACUOUS` — the README no longer references any `examples/` path, so the assertion
  checks nothing. Restore the references, or delete that assertion in the workflow
  deliberately. It fails loudly rather than passing silently on purpose.
- `FORBIDDEN <path>` — something private or huge is about to be published. Fix
  `files` / `.npmignore` before doing anything else.

### Gate 7 · CLI smoke test
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

`workflow_dispatch` exists for re-running a release whose publish step failed for an
infrastructure reason. It runs **the same gate** — there is no bypass, by design. It will
refuse to publish untagged code and will refuse a version already on the registry.

## 7. What this pipeline deliberately does not do

State these plainly rather than assuming them away:

- **It does not run on pull requests.** There is no PR-time CI for this repo, so a
  contributor's first signal is the release gate. Adding a separate `ci.yml` that runs
  `npm ci && npm test` on `push`/`pull_request` is the obvious next step; it was left out
  here to keep the publish path's behaviour a single, reviewable change.
- **It does not test on Windows.** The gate runs on `ubuntu-latest` only, while a large
  share of users — and the known `EPERM`/rename flakes — are on Windows. A matrix run is
  a follow-up.
- **It does not verify the installed flat bundle end to end**, only the npm tarball.
- **It cannot unpublish.** Every gate exists because the one thing that cannot be undone
  is a bad publish.
