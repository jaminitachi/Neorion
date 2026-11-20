# Release Neorion 0.5.0

Run the release from the repository root in Bash with Node.js 22 or later, GitHub CLI, jq, and Claude Code. The runtime CLI supports Node.js 18 or later. The npm manifest supplies `PKG` and `VERSION` in Step 2, including when using the scoped fallback.

## 1. Prepare the pull requests

Review and obtain approval for PR #1 on its final head. If it is still open, substitute the approved full SHA and merge it with a merge commit to preserve the history shared with PR #2.

```bash
(
  set -euo pipefail
  PR1_SHA='<approved full PR #1 SHA>'
  check_equal() {
    if [[ "$2" == "$3" ]]; then
      printf 'OK: %s (%s)\n' "$1" "$2"
    else
      printf 'FAIL: %s (got %s, expected %s)\n' "$1" "$2" "$3" >&2
      exit 1
    fi
  }
  check_approval() {
    local approved
    approved=$(gh api 'repos/{owner}/{repo}/pulls/1/reviews' --paginate --slurp |
      jq --arg head "$PR1_SHA" '
        flatten | map(select(
          (.author_association | IN("OWNER", "MEMBER", "COLLABORATOR"))
          and (.state | IN("APPROVED", "CHANGES_REQUESTED", "DISMISSED"))
        ))
        | group_by(.user.login) | map(max_by(.id))
        | any(.state == "APPROVED" and .commit_id == $head)
          and (any(.state == "CHANGES_REQUESTED") | not)
      ')
    check_equal 'PR #1 eligible approval on exact head, with no eligible change requests' "$approved" true
  }
  actual=$(gh pr view 1 --json headRefOid --jq .headRefOid)
  check_equal 'PR #1 head matches the approved SHA' "$actual" "$PR1_SHA"
  gh pr checks 1 --watch
  check_approval
  gh pr merge 1 --merge --match-head-commit "$PR1_SHA"
)
```

Once PR #1 has landed, merge the current `master` into the clean feature branch and push before retargeting PR #2. After the PR targets `master` and is ready, push an empty release-check commit to trigger a fresh Extension `pull_request/synchronize` run. The block creates that checkpoint once per base SHA. If the base advances before publishing, rerun this block, obtain fresh approval, and repeat Steps 2 and 3.

```bash
(
  set -euo pipefail
  git fetch origin
  branch=$(git branch --show-current)
  head=$(git rev-parse HEAD)
  remote_head=$(git rev-parse origin/feat/cli-and-skill)
  changes=$(git status --porcelain)
  if [[ "$branch" == feat/cli-and-skill && "$head" == "$remote_head" && -z "$changes" ]]; then
    echo "OK: clean feature branch at the remote head"
  else
    echo "FAIL: expected a clean feature branch at the remote head" >&2
    exit 1
  fi
  git merge --no-edit origin/master
  base=$(git rev-parse origin/master)
  pr_base=$(gh pr view 2 --json baseRefName --jq .baseRefName)
  draft=$(gh pr view 2 --json isDraft --jq .isDraft)
  if [[ "$(git rev-parse HEAD)" != "$remote_head" || "$pr_base" != master || "$draft" == true ]]; then
    git push origin HEAD:refs/heads/feat/cli-and-skill
  fi
  if [[ "$pr_base" != master ]]; then
    gh pr edit 2 --base master
  fi
  if [[ "$draft" == true ]]; then
    gh pr ready 2
  fi
  marker="Release-Base: $base"
  if [[ -z "$(git log "$base"..HEAD --fixed-strings --grep="$marker" -n 1 --format=%H)" ]]; then
    git commit --allow-empty -m "Run release checks against master" -m "$marker"
    git push origin HEAD:refs/heads/feat/cli-and-skill
  fi
)
```

Review the retargeted diff with `gh pr diff 2` and obtain approval for its new head.

## 2. Build, test, and inspect the tarball

The VSIX build compiles `extension/out`, which the tests load. Keep `npm ci` before both npm dry runs because their prepack install inherits dry-run mode. Set `NEORION_BENCH_REPOS` to the benchmark checkouts to include the four benchmark tests.

```bash
(
  set -euo pipefail
  PKG=$(node -p "require('./neorion/package.json').name")
  VERSION=$(node -p "require('./neorion/package.json').version")
  REGISTRY=https://registry.npmjs.org/
  check_equal() {
    if [[ "$2" == "$3" ]]; then
      printf 'OK: %s (%s)\n' "$1" "$2"
    else
      printf 'FAIL: %s (got %s, expected %s)\n' "$1" "$2" "$3" >&2
      exit 1
    fi
  }

  git fetch origin
  RELEASE_SHA=$(git rev-parse HEAD)
  BASE_SHA=$(git rev-parse origin/master)
  remote_head=$(git rev-parse origin/feat/cli-and-skill)
  changes=$(git status --porcelain)
  check_equal 'checkout matches remote feature head' "$RELEASE_SHA" "$remote_head"
  check_equal 'working tree is clean' "$changes" ''

  release_dir=$(mktemp -d)
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
  check_equal 'tarballs in release directory' "${#archives[@]}" 1
  TARBALL="${archives[0]}"
  tar -tvzf "$TARBALL"
  (
    export HOME="$release_dir/smoke-home"
    export npm_config_cache="$release_dir/smoke-cache"
    export npm_config_registry="$REGISTRY"
    mkdir -p "$HOME" "$release_dir/sample"
    npm install --global --offline --ignore-scripts --prefix "$release_dir/smoke-prefix" "$TARBALL"
    installed_version=$("$release_dir/smoke-prefix/bin/neorion" --version)
    check_equal 'installed CLI version' "$installed_version" "$VERSION"
    cd "$release_dir/sample"
    printf '{}\n' > tsconfig.json
    printf 'export const Example = 1;\n' > example.ts
    graph=$(npx --yes --offline --package="$TARBALL" neorion graph)
    printf '%s\n' "$graph"
    mcp=$(printf '%s\n' "$graph" | sed -n 's/^MCP: *//p')
    check_equal 'npx MCP command' "$mcp" "{\"command\":\"npx\",\"args\":[\"-y\",\"$PKG@$VERSION\",\"mcp\"]}"
    npx --yes --offline --package="$TARBALL" neorion query search Example
  )
  SHA512=$(sha512sum "$TARBALL")
  printf '%s=%q\n' PKG "$PKG" VERSION "$VERSION" REGISTRY "$REGISTRY" \
    RELEASE_SHA "$RELEASE_SHA" BASE_SHA "$BASE_SHA" TARBALL "$TARBALL" SHA512 "$SHA512" > "$release_dir/release.env"
  printf 'Inspected archive: %s\nSHA-512: %s\nRelease head: %s\nRelease record: %s\n' \
    "$TARBALL" "${SHA512%% *}" "$RELEASE_SHA" "$release_dir/release.env"
)
```

The strict validation may report `ICON_MISSING`. Review dependency audit results separately, including the moderate minimatch advisory reported during release prep.

Check the archive listing for both bundles, the skill, the plugin and MCP manifests, and the license notices. Keep the archive and its `release.env` together until the release finishes. The record contains no credentials. Set `RELEASE_ENV` to the printed absolute path in a new terminal after authenticating. Keep the original archive if the terminal closes.

## 3a. Confirm remote gates and publish

Use the public registry for authentication (`npm login --registry=https://registry.npmjs.org/`, then `npm whoami --registry=https://registry.npmjs.org/`). An E404 for the candidate version is expected before publication. Investigate any change to the historical record for `neorion` before proceeding. A dry run cannot establish ownership of the previously unpublished unscoped name. [Historical registry record](https://registry.npmjs.org/neorion)

Confirm the PR #2 approval covers the SHA printed in Step 2. Only reviews from repository owners, members, and collaborators count. The block requires an Extension pull request run on that exact head and checks the PR's current aggregate results. If the workflow has yet to appear, wait and rerun this block. The run's associated PR metadata is an extra check. The ancestry check and live master SHA check verify the release tree and current base.

```bash
(
  set -euo pipefail
  source "${RELEASE_ENV:-/absolute/path/to/release.env}"
  check_equal() {
    if [[ "$2" == "$3" ]]; then
      printf 'OK: %s (%s)\n' "$1" "$2"
    else
      printf 'FAIL: %s (got %s, expected %s)\n' "$1" "$2" "$3" >&2
      exit 1
    fi
  }
  check_pr() {
    local actual base
    actual=$(gh pr view 2 --json baseRefName,headRefName,headRefOid,isDraft,state \
      --jq '[.baseRefName,.headRefName,.headRefOid,.isDraft,.state] | @tsv')
    check_equal 'PR #2 is open, ready, and matches the release base and head' \
      "$actual" "$(printf 'master\tfeat/cli-and-skill\t%s\tfalse\tOPEN' "$RELEASE_SHA")"
    base=$(git ls-remote --exit-code origin refs/heads/master)
    check_equal 'master matches the recorded base' "${base%%$'\t'*}" "$BASE_SHA"
  }

  check_approval() {
    local approved
    approved=$(gh api 'repos/{owner}/{repo}/pulls/2/reviews' --paginate --slurp |
      jq --arg head "$RELEASE_SHA" '
        flatten | map(select(
          (.author_association | IN("OWNER", "MEMBER", "COLLABORATOR"))
          and (.state | IN("APPROVED", "CHANGES_REQUESTED", "DISMISSED"))
        ))
        | group_by(.user.login) | map(max_by(.id))
        | any(.state == "APPROVED" and .commit_id == $head)
          and (any(.state == "CHANGES_REQUESTED") | not)
      ')
    check_equal 'PR #2 eligible approval on exact head, with no eligible change requests' "$approved" true
  }

  prerequisite=$(gh pr view 1 --json state --jq .state)
  check_equal 'prerequisite PR #1 state' "$prerequisite" MERGED
  check_pr
  if git merge-base --is-ancestor "$BASE_SHA" "$RELEASE_SHA"; then
    echo "OK: release tree includes the recorded master base"
  else
    echo "FAIL: merge master into the feature branch, then repeat the review and build" >&2
    exit 1
  fi
  check_approval
  run_id=$(gh run list --workflow extension.yml --event pull_request \
    --branch feat/cli-and-skill --commit "$RELEASE_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  if [[ -z "$run_id" ]]; then
    echo "FAIL: no Extension pull request run on $RELEASE_SHA" >&2
    exit 1
  fi
  run_base=$(gh api "repos/{owner}/{repo}/actions/runs/$run_id" --jq \
    '.pull_requests[]? | select(.number == 2 and .base.ref == "master") | .base.sha')
  if [[ -z "$run_base" || "$run_base" == null ]]; then
    echo "FAIL: Extension run $run_id has no master base SHA associated with PR #2. Wait for the retargeted PR run and retry." >&2
    exit 1
  fi
  check_equal 'Extension run metadata associates PR #2 with the recorded master base' "$run_base" "$BASE_SHA"
  gh run watch "$run_id" --exit-status
  gh pr checks 2 --watch --fail-fast
  check_pr
  checksum=$(sha512sum "$TARBALL")
  check_equal 'inspected tarball SHA-512' "$checksum" "$SHA512"
  if registry_result=$(npm view "$PKG@$VERSION" version --json --registry="$REGISTRY"); then
    printf 'FAIL: registry lookup succeeded for %s@%s (%s)\n' "$PKG" "$VERSION" "$registry_result" >&2
    exit 1
  fi
  if ! registry_code=$(printf '%s' "$registry_result" | jq -er '.error.code'); then
    echo 'FAIL: npm did not return a registry error code' >&2
    exit 1
  fi
  check_equal 'candidate version is absent from the registry' "$registry_code" E404
  check_approval
  check_pr
  npm publish "$TARBALL" --access public --registry="$REGISTRY"
)
```

## 3b. Verify the published release and merge

Run from the repository root using the same `release.env`. If publish succeeded or its outcome is uncertain, start here. The registry check retries for up to nine ten-second waits, plus the time for each request. Rerun this block after resolving any failure. A PR already merged at the recorded head exits successfully.

```bash
(
  set -euo pipefail
  source "${RELEASE_ENV:-/absolute/path/to/release.env}"
  check_equal() {
    if [[ "$2" == "$3" ]]; then
      printf 'OK: %s (%s)\n' "$1" "$2"
    else
      printf 'FAIL: %s (got %s, expected %s)\n' "$1" "$2" "$3" >&2
      exit 1
    fi
  }
  check_pr() {
    local actual base
    actual=$(gh pr view 2 --json baseRefName,headRefName,headRefOid,isDraft,state \
      --jq '[.baseRefName,.headRefName,.headRefOid,.isDraft,.state] | @tsv')
    check_equal 'PR #2 is open, ready, and matches the release base and head' \
      "$actual" "$(printf 'master\tfeat/cli-and-skill\t%s\tfalse\tOPEN' "$RELEASE_SHA")"
    base=$(git ls-remote --exit-code origin refs/heads/master)
    check_equal 'master matches the recorded base' "${base%%$'\t'*}" "$BASE_SHA"
  }

  check_approval() {
    local approved
    approved=$(gh api 'repos/{owner}/{repo}/pulls/2/reviews' --paginate --slurp |
      jq --arg head "$RELEASE_SHA" '
        flatten | map(select(
          (.author_association | IN("OWNER", "MEMBER", "COLLABORATOR"))
          and (.state | IN("APPROVED", "CHANGES_REQUESTED", "DISMISSED"))
        ))
        | group_by(.user.login) | map(max_by(.id))
        | any(.state == "APPROVED" and .commit_id == $head)
          and (any(.state == "CHANGES_REQUESTED") | not)
      ')
    check_equal 'PR #2 eligible approval on exact head, with no eligible change requests' "$approved" true
  }

  merged_head=$(gh pr view 2 --json state,headRefOid --jq 'select(.state == "MERGED") | .headRefOid')
  if [[ -n "$merged_head" ]]; then
    check_equal 'PR #2 already merged at the release head' "$merged_head" "$RELEASE_SHA"
    exit 0
  fi
  check_pr
  checksum=$(sha512sum "$TARBALL")
  check_equal 'inspected tarball SHA-512' "$checksum" "$SHA512"
  local_integrity=$(node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    console.log("sha512-" + createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"));
  ' "$TARBALL")
  for attempt in {1..10}; do
    if registry_integrity=$(npm view "$PKG@$VERSION" dist.integrity --registry="$REGISTRY" --prefer-online) &&
        [[ -n "$registry_integrity" ]]; then
      break
    fi
    if [[ "$attempt" == 10 ]]; then
      printf 'FAIL: registry integrity unavailable for %s@%s after %s attempts. Rerun Step 3b.\n' "$PKG" "$VERSION" "$attempt" >&2
      exit 1
    fi
    printf 'Waiting for registry integrity for %s@%s (%s/10)\n' "$PKG" "$VERSION" "$attempt" >&2
    sleep 10
  done
  check_equal 'public registry integrity' "$registry_integrity" "$local_integrity"
  (
    verify_dir=$(mktemp -d)
    trap 'rm -rf -- "$verify_dir"' EXIT
    cd "$verify_dir"
    export HOME="$verify_dir/home"
    export npm_config_cache="$verify_dir/npm-cache"
    export npm_config_registry="$REGISTRY"
    export CLAUDE_CONFIG_DIR="$verify_dir/claude-config"
    mkdir -p "$HOME"
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
    installed_version=$(npx --yes --package="$PKG@$VERSION" neorion --version)
    check_equal 'public CLI version' "$installed_version" "$VERSION"
    printf '{}\n' > tsconfig.json
    printf 'export const Example = 1;\n' > example.ts
    npx --yes --package="$PKG@$VERSION" neorion graph
    npx --yes --package="$PKG@$VERSION" neorion query search Example
    claude plugin marketplace add 'jaminitachi/Neorion#feat/cli-and-skill'
    claude plugin install neorion@neorion
  )
  gh pr checks 2 --watch --fail-fast
  check_approval
  check_pr
  gh pr merge 2 --squash --match-head-commit "$RELEASE_SHA"
)
```

Keep PR #2 open until verification passes. If its head changes after publishing 0.5.0, retire that candidate. Deprecate 0.5.0 using the rollback command. Bump to 0.5.1 in the CLI and extension manifests, the extension lockfile's root version fields, and the Claude plugin manifest. Update the marketplace npm pin and both README npm invocations. Push the new head, obtain fresh approval, and repeat Steps 2, 3a, and 3b with the new archive and record. If master advances, integrate it into the feature branch and follow the same replacement-version procedure.

### Scoped fallback

If npm rejects the unscoped name for ownership or name policy, update the npm manifest name, the marketplace's `plugins[0].source.package`, and the versioned npm invocations in `README.md` and `neorion/README.md`. Keep `publishConfig.access` set to `public`. The npm executable, Claude plugin ID, and Codex MCP server name are `neorion`. Use the npm rename script in the release prep evidence or make these changes directly. Commit and push the scoped changes to the feature branch, then obtain fresh approval and repeat Steps 2 and 3. npm supplies the archive filename, for example `jaminitachi-neorion-0.5.0.tgz` for `@jaminitachi/neorion`. [npm scope documentation](https://docs.npmjs.com/cli/v11/using-npm/scope/)

## User installation

For shell commands, load `PKG` and `VERSION` from the release record or set them to the published name and version. Run from the project directory.

```bash
npx --yes --package="$PKG@$VERSION" neorion graph
```

In Claude Code, run these after the marketplace lands on `master`.

```text
/plugin marketplace add jaminitachi/Neorion
/plugin install neorion@neorion
```

For Codex, run setup and start a new Codex session in your project.

```bash
npx --yes --package="$PKG@$VERSION" neorion setup codex &&
codex mcp list
```

## Rollback

Use the affected release's `PKG`, `VERSION`, and `REGISTRY` from its release record. Prefer deprecation so users see a warning and pinned installations can still start. Add `--otp=<code>` to the npm write commands when npm requires a one-time password.

```bash
npm deprecate "${PKG:?}@${VERSION:?}" \
  "This version has been withdrawn. See https://github.com/jaminitachi/Neorion for updates." \
  --registry="${REGISTRY:?}"
```

Open a rollback PR against `master` to change the marketplace pin. If a working predecessor exists, restore its npm package and version. For the first release (0.5.0), prepare a fixed 0.5.1 in the rollback PR. Set `plugins[0].source.version` to `0.5.1` and update `plugins[0].source.package` if the replacement uses a different package name. Publish and verify the replacement before merging the rollback PR. Keep the marketplace file and its Neorion entry so existing users can refresh it and strict validation succeeds. Run the validation below from the rollback checkout before merging. While the replacement is pending, tell users to uninstall the withdrawn plugin and pause new installs.

```bash
(
  set -euo pipefail
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  export CLAUDE_CONFIG_DIR="$(mktemp -d)"
  trap 'rm -rf -- "$CLAUDE_CONFIG_DIR"' EXIT
  claude plugin validate --strict .claude-plugin/marketplace.json
)
```

In Claude Code, run `/plugin uninstall neorion@neorion` and restart Claude Code to remove the withdrawn plugin. Once the corrected marketplace pin lands, run `claude plugin marketplace update neorion` in your shell. Then run `claude plugin update neorion@neorion` for an existing installation or `claude plugin install neorion@neorion` if you uninstalled it. Use the same install scope as before and restart Claude Code to load the replacement. [Claude Code plugin commands](https://code.claude.com/docs/en/plugins/cli-reference)

Reserve unpublishing for cases that require removal and meet npm's policy. When 0.5.0 is the only version, `--force` removes the entire package. This imposes a 24-hour lockout on new publications, permanently burns that name/version pair, and may cost the unscoped name because it was already fully unpublished once. Existing Codex setups pinned to `npx -y neorion@0.5.0 mcp` will fail to start when npm needs to fetch it. The same applies to a scoped pin if its package is withdrawn. Publish a fixed version under an available name and have users rerun setup to refresh their pin. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)

```bash
npm unpublish "${PKG:?}@${VERSION:?}" --force --registry="${REGISTRY:?}"
```
