# Release Neorion

Run from the repository root with Bash, Node.js 22+, GitHub CLI, jq, and Claude Code. The solo maintainer approves the release by running this runbook. Review each PR's diff before proceeding. Don't merge other PRs into master during the release.

Check out the release branch. Set `RELEASE_PR` to its PR number and, for a stacked release, `PREP_PR` to the prerequisite PR number. For the first release these are 2 and 1, respectively.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: could not create release record" >&2' ERR
  [[ ${RELEASE_PR:-} =~ ^[1-9][0-9]*$ ]] ||
    { echo 'FAIL: set RELEASE_PR to the release PR number' >&2; exit 1; }
  BRANCH=$(git symbolic-ref --short HEAD)
  PKG=$(node -p "require('./neorion/package.json').name")
  VERSION=$(node -p "require('./neorion/package.json').version")
  REGISTRY=https://registry.npmjs.org/
  RELEASE_ENV="$(git rev-parse --path-format=absolute --git-common-dir)/neorion-release/$VERSION/release.env"
  settings=$(printf '%s=%q\n' PREP_PR "${PREP_PR:-}" RELEASE_PR "$RELEASE_PR" BRANCH "$BRANCH" \
    REGISTRY "$REGISTRY" PKG "$PKG" VERSION "$VERSION")
  if [[ -f "$RELEASE_ENV" ]]; then
    echo "Existing release record at $RELEASE_ENV"
    cat "$RELEASE_ENV"
    recorded=$(grep -E '^(PREP_PR|RELEASE_PR|BRANCH|REGISTRY|PKG|VERSION)=' "$RELEASE_ENV")
    [[ "$recorded" == "$settings" ]] ||
      { echo "FAIL: settings differ. Before publishing, delete $(dirname "$RELEASE_ENV") and rerun setup." >&2; exit 1; }
  else
    mkdir -p "$(dirname "$RELEASE_ENV")"
    printf '%s\n' "$settings" > "$RELEASE_ENV"
  fi
  echo "OK: release settings at $RELEASE_ENV"
)
```

In a new terminal, rerun the failed step from a checkout of the same release version to find its record.

## 1. Prepare the PRs

For the stacked first release, review the prerequisite PR and run this block. A fix PR already based on master can start at Step 2.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: prerequisite PR checks or merge failed" >&2' ERR
  source "${RELEASE_ENV:-"$(git rev-parse --path-format=absolute --git-common-dir)/neorion-release/$(node -p "require('./neorion/package.json').version")/release.env"}"
  : "${PREP_PR:?Set PREP_PR for a stacked release}"
  if [[ "$(gh pr view "$PREP_PR" --json state --jq .state)" == MERGED ]]; then
    echo "OK: prerequisite PR already merged"
    exit 0
  fi
  head=$(gh pr view "$PREP_PR" --json headRefOid --jq .headRefOid)
  gh pr checks "$PREP_PR" --watch --fail-fast
  gh pr merge "$PREP_PR" --merge --match-head-commit "$head"
  echo "OK: prerequisite PR merged at $head"
)
```

Run the second block on the release branch. The empty commit triggers a fresh pull-request run after retargeting and marking ready. If a push fails, rerun this block from the same checkout. If the merge conflicts, resolve and commit the conflicts or run `git merge --abort`, then rerun.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: release branch preparation failed" >&2' ERR
  source "${RELEASE_ENV:-"$(git rev-parse --path-format=absolute --git-common-dir)/neorion-release/$(node -p "require('./neorion/package.json').version")/release.env"}"
  : "${PREP_PR:?Set PREP_PR for a stacked release}"
  [[ "$(gh pr view "$PREP_PR" --json state --jq .state)" == MERGED ]] ||
    { echo "FAIL: prerequisite PR #$PREP_PR must be MERGED" >&2; exit 1; }
  git fetch origin
  [[ "$(git branch --show-current)" == "$BRANCH" && -z "$(git status --porcelain)" ]] &&
    git merge-base --is-ancestor "origin/$BRANCH" HEAD ||
    { echo "FAIL: need a clean $BRANCH containing the remote branch tip" >&2; exit 1; }
  push_head() {
    if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]]; then
      git push origin "HEAD:refs/heads/$BRANCH" ||
        { echo "FAIL: push to $BRANCH failed; rerun this block from this checkout" >&2; return 1; }
    fi
  }
  push_head
  git merge --no-edit origin/master
  push_head
  pr=$(gh pr view "$RELEASE_PR" --json baseRefName,isDraft,headRefName,state \
    --jq '[.baseRefName,.isDraft,.headRefName,.state] | @tsv')
  read -r base draft pr_branch state <<< "$pr"
  [[ "$pr_branch" == "$BRANCH" && "$state" == OPEN ]] ||
    { echo "FAIL: PR #$RELEASE_PR must be open from $BRANCH" >&2; exit 1; }
  if [[ "$base" != master ]]; then
    gh pr edit "$RELEASE_PR" --base master
  fi
  if [[ "$draft" == true ]]; then
    gh pr ready "$RELEASE_PR"
  fi
  marker="Release-Base: $(git rev-parse origin/master)"
  if [[ "$base" != master || "$draft" == true ||
    -z "$(git log origin/master..HEAD --fixed-strings --grep="$marker" -n 1 --format=%H)" ]]; then
    git commit --allow-empty -m "Run release checks against master" -m "$marker"
    push_head
  fi
  echo "OK: release PR ready against master"
)
```

## 2. Build and inspect the tarball

Review the release PR's current diff. The VSIX build compiles the code used by the tests. Set `NEORION_BENCH_REPOS` to include the benchmark tests.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: release build or smoke test failed" >&2' ERR
  RELEASE_ENV=${RELEASE_ENV:-"$(git rev-parse --path-format=absolute --git-common-dir)/neorion-release/$(node -p "require('./neorion/package.json').version")/release.env"}
  source "$RELEASE_ENV"
  git fetch origin
  RELEASE_SHA=$(git rev-parse HEAD)
  [[ "$(git branch --show-current)" == "$BRANCH" && -z "$(git status --porcelain)" &&
    "$RELEASE_SHA" == "$(git rev-parse "origin/$BRANCH")" ]] ||
    { echo "FAIL: need a clean checkout at the remote $BRANCH head" >&2; exit 1; }
  [[ "$PKG@$VERSION" == "$(node -p "const p = require('./neorion/package.json'); p.name + '@' + p.version")" ]] ||
    { echo 'FAIL: release settings differ from the npm manifest' >&2; exit 1; }
  release_dir=$(mktemp -d)
  trap 'rm -rf -- "$release_dir"' EXIT
  npm --prefix extension ci --include=dev
  (cd extension && npx --no-install vsce package --out "$release_dir/neorion-$VERSION.vsix")
  CI=1 npm --prefix extension test
  (
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
    export CLAUDE_CONFIG_DIR="$release_dir/claude-config"
    claude plugin validate --strict .claude-plugin/marketplace.json
    claude plugin validate --strict neorion
  )
  (
    cd neorion
    npm pack --dry-run --registry="$REGISTRY"
    npm publish --dry-run --registry="$REGISTRY"
    npm pack --registry="$REGISTRY" --pack-destination "$release_dir"
  )
  shopt -s nullglob
  archives=("$release_dir"/*.tgz)
  [[ ${#archives[@]} == 1 ]] ||
    { echo 'FAIL: expected exactly one tarball' >&2; exit 1; }
  TARBALL=${archives[0]}
  tar -tvzf "$TARBALL"
  mkdir "$release_dir/sample"
  (
    cd "$release_dir/sample"
    export npm_config_cache="$release_dir/npm-cache" XDG_CACHE_HOME="$release_dir/cache"
    printf '{}\n' > tsconfig.json
    printf 'export const Example = 1;\n' > example.ts
    test "$(npx --yes --offline --package="$TARBALL" neorion --version)" = "$VERSION"
    graph=$(npx --yes --offline --package="$TARBALL" neorion graph)
    printf '%s\n' "$graph"
    grep -Fx "MCP:      {\"command\":\"npx\",\"args\":[\"-y\",\"$PKG@$VERSION\",\"mcp\"]}" <<< "$graph"
    npx --yes --offline --package="$TARBALL" neorion query search Example
  )
  mv -- "$TARBALL" "$(dirname "$RELEASE_ENV")/"
  TARBALL="$(dirname "$RELEASE_ENV")/${TARBALL##*/}"
  SHA512=$(sha512sum "$TARBALL")
  printf '%s=%q\n' PREP_PR "${PREP_PR:-}" RELEASE_PR "$RELEASE_PR" BRANCH "$BRANCH" \
    REGISTRY "$REGISTRY" PKG "$PKG" VERSION "$VERSION" \
    RELEASE_SHA "$RELEASE_SHA" TARBALL "$TARBALL" SHA512 "$SHA512" > "$release_dir/release.env"
  mv -- "$release_dir/release.env" "$RELEASE_ENV"
  printf 'OK: archive %s\nSHA-512: %s\nRelease head: %s\n' "$TARBALL" "${SHA512%% *}" "$RELEASE_SHA"
)
```

Review the archive listing for both bundles, the skill, the plugin and MCP manifests, and the license notices. Keep the original archive and release record together until the release finishes. The `ICON_MISSING` and npm `allowScripts` warnings are known and harmless for these checks.

## 3a. Check CI and publish

Use an authenticated npm session. Only an E404 qualifies as an absent version.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: publish preflight or npm publish failed" >&2' ERR
  source "${RELEASE_ENV:-"$(git rev-parse --path-format=absolute --git-common-dir)/neorion-release/$(node -p "require('./neorion/package.json').version")/release.env"}"
  check_pr() {
    local actual
    actual=$(gh pr view "$RELEASE_PR" --json baseRefName,headRefName,headRefOid,isDraft,state \
      --jq '[.baseRefName,.headRefName,.headRefOid,.isDraft,.state] | @tsv')
    [[ "$actual" == "$(printf 'master\t%s\t%s\tfalse\tOPEN' "$BRANCH" "$RELEASE_SHA")" ]] ||
      { echo "FAIL: PR #$RELEASE_PR must be open and ready against master at $RELEASE_SHA (got $actual)" >&2; exit 1; }
  }
  check_pr
  run=$(gh run list --workflow extension.yml --event pull_request --branch "$BRANCH" \
    --commit "$RELEASE_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  [[ -n "$run" ]] ||
    { echo "FAIL: no Extension pull-request run on $RELEASE_SHA; wait and retry" >&2; exit 1; }
  gh run watch "$run" --exit-status
  gh pr checks "$RELEASE_PR" --watch --fail-fast
  [[ "$(sha512sum "$TARBALL")" == "$SHA512" ]] ||
    { echo 'FAIL: inspected tarball SHA-512 changed' >&2; exit 1; }
  if result=$(npm view "$PKG@$VERSION" version --json --registry="$REGISTRY" --prefer-online); then
    echo "FAIL: $PKG@$VERSION already exists. Go to Step 3b." >&2
    exit 1
  fi
  [[ "$(jq -r '.error.code' <<< "$result")" == E404 ]] ||
    { echo "FAIL: npm did not confirm $PKG@$VERSION is absent" >&2; exit 1; }
  check_pr
  echo "OK: exact-head CI, tarball SHA-512, and version availability"
  npm publish "$TARBALL" --access public --registry="$REGISTRY"
  echo "OK: published $PKG@$VERSION"
)
```

If npm rejects the unscoped name, use this fallback.

1. Stop the publish attempt.
2. Set the new `PKG` by changing the npm manifest name to `@<npm-user>/neorion` (for example, `@jaminitachi/neorion`). Update the marketplace package and the npm pins in `README.md` and `neorion/README.md`. Replace `neorion@0.5.0` in both User installation commands below with the scoped pin. Keep public access, the `neorion` executable, and the plugin ID.
3. Delete the unpublished version's record directory (the parent of the `release.env` path printed by setup), then rerun setup.
4. Commit and push the changes to the release branch, rerun Step 2, then rerun 3a.

## 3b. Verify the published release and merge

Use the same record, including when publish had an uncertain outcome or the PR is already merged. A merge commit preserves the published head in history.
To recover a lost 3b record, restore `PKG`, `VERSION`, `REGISTRY`, `RELEASE_PR`, `BRANCH`, and `RELEASE_SHA`, plus `SHA512` from the SHA-512 hex printed by Step 2.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: published release verification or merge failed" >&2' ERR
  source "${RELEASE_ENV:-"$(git rev-parse --path-format=absolute --git-common-dir)/neorion-release/$(node -p "require('./neorion/package.json').version")/release.env"}"
  : "${SHA512:?run Step 2 first}"
  expected=$(node -e 'console.log("sha512-" + Buffer.from(process.argv[1], "hex").toString("base64"))' "${SHA512%% *}")
  for attempt in {1..10}; do
    if result=$(npm view "$PKG@$VERSION" dist.integrity --json --registry="$REGISTRY" --prefer-online) &&
      integrity=$(jq -er 'strings | select(length > 0)' <<< "$result"); then
      break
    fi
    if [[ "$attempt" == 10 ]]; then
      if [[ "$(jq -r '.error.code // empty' <<< "$result")" == E404 ]]; then
        echo "FAIL: $PKG@$VERSION still returns E404. Go back to Step 3a." >&2
      else
        echo 'FAIL: registry integrity unavailable after 10 attempts. Rerun Step 3b.' >&2
      fi
      exit 1
    fi
    echo "Waiting for registry integrity ($attempt/10)"
    sleep 10
  done
  [[ "$integrity" == "$expected" ]] ||
    { echo 'FAIL: registry integrity differs from inspected archive' >&2; exit 1; }
  echo 'OK: registry integrity matches'
  verify_dir=$(mktemp -d)
  trap 'rm -rf -- "$verify_dir"' EXIT
  mkdir "$verify_dir/marketplace" "$verify_dir/home" "$verify_dir/sample"
  git archive "$RELEASE_SHA" .claude-plugin | tar -x -C "$verify_dir/marketplace"
  (
    cd "$verify_dir/sample"
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
    export HOME="$verify_dir/home" CLAUDE_CONFIG_DIR="$verify_dir/claude-config"
    export npm_config_cache="$verify_dir/npm-cache" npm_config_registry="$REGISTRY" XDG_CACHE_HOME="$verify_dir/cache"
    test "$(npx --yes --package="$PKG@$VERSION" neorion --version)" = "$VERSION"
    printf '{}\n' > tsconfig.json
    printf 'export const Example = 1;\n' > example.ts
    npx --yes --package="$PKG@$VERSION" neorion graph
    npx --yes --package="$PKG@$VERSION" neorion query search Example
    claude plugin marketplace add "$verify_dir/marketplace"
    claude plugin install neorion@neorion
    claude plugin list --json | jq -e --arg version "$VERSION" \
      'any(.[]; .id == "neorion@neorion" and .version == $version and .enabled)' >/dev/null ||
      { echo "FAIL: expected enabled Claude plugin at $VERSION" >&2; exit 1; }
  )
  echo "OK: npx smoke and Claude plugin $VERSION from marketplace at $RELEASE_SHA"
  merged_commit() {
    gh pr view "$RELEASE_PR" --json state,mergeCommit \
      --jq 'select(.state == "MERGED") | .mergeCommit.oid // empty'
  }
  merge_sha=$(merged_commit)
  if [[ -z "$merge_sha" ]]; then
    pr=$(gh pr view "$RELEASE_PR" --json baseRefName,headRefName,headRefOid,isDraft,state \
      --jq '[.baseRefName,.headRefName,.headRefOid,.isDraft,.state] | @tsv')
    [[ "$pr" == "$(printf 'master\t%s\t%s\tfalse\tOPEN' "$BRANCH" "$RELEASE_SHA")" ]] ||
      { echo "FAIL: PR #$RELEASE_PR must be open and ready against master at $RELEASE_SHA (got $pr)" >&2; exit 1; }
    gh pr checks "$RELEASE_PR" --watch --fail-fast
    gh pr merge "$RELEASE_PR" --merge --match-head-commit "$RELEASE_SHA"
    merge_sha=$(merged_commit)
  fi
  git fetch origin master
  [[ -n "$merge_sha" ]] && git merge-base --is-ancestor "$RELEASE_SHA" "$merge_sha" ||
    { echo "FAIL: PR #$RELEASE_PR merge commit must contain $RELEASE_SHA" >&2; exit 1; }
  echo "OK: merge commit $merge_sha contains $RELEASE_SHA"
)
```

## User installation

From a project directory, run graph and register the MCP server, then start a new Codex session.

```bash
npx --yes --package=neorion@0.5.0 neorion graph
npx --yes --package=neorion@0.5.0 neorion setup codex
```

After the marketplace lands on master, use `/plugin marketplace add jaminitachi/Neorion` and `/plugin install neorion@neorion` in Claude Code.

For the **maintainer post-release check**, run from the repository root.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: graph or Codex setup failed" >&2' ERR
  source "${RELEASE_ENV:-"$(git rev-parse --path-format=absolute --git-common-dir)/neorion-release/$(node -p "require('./neorion/package.json').version")/release.env"}"
  npx --yes --package="$PKG@$VERSION" neorion graph
  npx --yes --package="$PKG@$VERSION" neorion setup codex
  codex mcp list
  echo 'OK: graph and Codex MCP setup complete'
)
```

## Rollback

Set `RELEASE_ENV` to the original release record of the version you intend to withdraw before running either block.

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: npm deprecation failed" >&2' ERR
  source "${RELEASE_ENV:?set RELEASE_ENV to the record of the version you want to roll back}"
  echo "Deprecate $PKG@$VERSION"
  IFS= read -r -p "Type $PKG@$VERSION to confirm: " confirmation &&
    [[ "$confirmation" == "$PKG@$VERSION" ]] || { echo 'Deprecate cancelled' >&2; exit 1; }
  npm deprecate "$PKG@$VERSION" \
    "This version has been withdrawn. See https://github.com/jaminitachi/Neorion for updates." \
    --registry="$REGISTRY"
  echo "OK: deprecated $PKG@$VERSION"
)
```

If the PR head moves after publication and 0.5.0 is sound, reset the release branch to `RELEASE_SHA`, restore that head on the PR, and rerun 3b. If 0.5.0 needs a fix, deprecate it and prepare 0.5.1 on the release PR or open a fix PR against master if it already merged. Update the CLI, extension, extension lockfile, and plugin versions, the marketplace's npm pin, and both README invocations. Keep the marketplace entry. Use a fresh record and repeat Steps 2, 3a, and 3b.

Once 0.5.1 is available, tell MCP users to rerun versioned `neorion setup` or update their MCP pin to 0.5.1 and restart the client. Claude users can uninstall the withdrawn plugin while waiting. Once the new marketplace pin lands, refresh it with `claude plugin marketplace update neorion`, then update or reinstall `neorion@neorion` in the same scope and restart Claude Code.

Reserve unpublish for cases that meet npm's removal policy. Publish 0.5.1 first, then unpublish only 0.5.0 without `--force` using the 0.5.0 release record. Full unpublish can lose the package name. Give MCP users the same setup or pin-refresh instructions. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)

```bash
(
  set -euo pipefail
  trap 'echo "FAIL: npm unpublish failed" >&2' ERR
  source "${RELEASE_ENV:?set RELEASE_ENV to the record of the version you want to roll back}"
  echo "Unpublish $PKG@$VERSION"
  IFS= read -r -p "Type $PKG@$VERSION to confirm: " confirmation &&
    [[ "$confirmation" == "$PKG@$VERSION" ]] || { echo 'Unpublish cancelled' >&2; exit 1; }
  npm unpublish "$PKG@$VERSION" --registry="$REGISTRY"
  echo "OK: unpublished $PKG@$VERSION"
)
```
