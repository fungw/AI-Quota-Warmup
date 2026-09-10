# Coveralls setup

This guide connects the Cloudflare Worker test coverage to Coveralls and adds a
coverage check and badge to the repository.

## 1. Confirm the repository is eligible

The repository must be public and have an open-source license. This repository
uses the MIT license, so it qualifies for Coveralls' open-source plan.

## 2. Create or sign in to Coveralls

1. Open [Coveralls](https://coveralls.io/).
2. Sign in with GitHub.
3. Authorize Coveralls to access GitHub if prompted.
4. Select `fungw/AI-Quota-Warmup`, if it is listed.

The GitHub Action can also create the repository entry when it receives the
first coverage upload, so it is fine if the repository is not visible in the
Coveralls dashboard yet.

## 3. Check the local coverage output

The Worker already uses Vitest with Istanbul coverage and produces an LCOV
report at `worker/coverage/lcov.info`:

```bash
cd worker
npm ci
npm run test:coverage
test -f coverage/lcov.info
```

The command also enforces the existing 100% statements, branches, functions,
and lines thresholds.

## 4. Add the Coveralls upload step to CI

Edit `.github/workflows/test.yml` and add this step after
`npm run test:coverage`:

```yaml
      - name: Upload coverage to Coveralls
        uses: coverallsapp/github-action@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          file: worker/coverage/lcov.info
          format: lcov
          base-path: worker
```

`GITHUB_TOKEN` is supplied automatically by GitHub Actions; do not create a
long-lived Coveralls token for this public repository.

Keep the workflow triggers on both pushes and pull requests so Coveralls can
record the main-branch history and report coverage changes on pull requests.

## 5. Push the workflow

Commit the workflow change and push it to GitHub:

```bash
git add .github/workflows/test.yml
git commit -m "ci: publish test coverage to Coveralls"
git push origin main
```

Open the workflow run under the repository's **Actions** tab. The Coveralls
step should run after the tests and report the uploaded LCOV file.

## 6. Add the README badge

Add this near the title in `README.md`:

```md
[![Test Coverage](https://coveralls.io/repos/github/fungw/AI-Quota-Warmup/badge.svg?branch=main)](https://coveralls.io/github/fungw/AI-Quota-Warmup?branch=main)
```

The badge will show a value after the first successful upload. If the default
branch changes, replace both `main` values with the actual default branch.

## 7. Optional pull-request comments

Coveralls can comment on pull requests with coverage changes. In the Coveralls
repository settings, enable the pull-request comment option. If comments do
not appear, check that the workflow runs on `pull_request` and review the
permissions requested by the Coveralls integration.

## Troubleshooting

- **No coverage file found:** Confirm that the test step runs from the
  repository root for the action and that `file: worker/coverage/lcov.info` is
  present.
- **Coverage paths look wrong:** Keep `base-path: worker`; the report is
  generated from the Worker subdirectory.
- **The upload fails:** Open the failed step's log and verify that the test
  step completed successfully before the Coveralls step.
- **The badge is blank:** Wait for the first successful upload, then confirm
  that the badge URL uses the repository's real default branch.

## References

- [Coveralls pricing and open-source plan](https://coveralls.io/pricing)
- [Coveralls GitHub Action](https://github.com/coverallsapp/github-action)
- [Coveralls documentation](https://docs.coveralls.io/)
