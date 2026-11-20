# Release Neorion 0.5.0

대한님 runs the release from a clean checkout of the reviewed `feat/cli-and-skill` branch using Node.js 22 or later. The runtime CLI supports Node.js 18 or later.

## 1. Sign in to npm

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

## 2. Check the branch, package name, and tarball

From the repository root, confirm that the checkout matches the approved PR head and the working tree is clean. Check the PR base before merging in step 5.

```sh
git fetch origin
git status --short --branch
git rev-parse HEAD origin/feat/cli-and-skill
gh pr view 2 --json baseRefName,headRefName,isDraft
npm view neorion@0.5.0 version --registry=https://registry.npmjs.org/
curl -fsS https://registry.npmjs.org/neorion
npm --prefix extension ci
CI=1 npm --prefix extension test
(cd extension && npx --no-install vsce package)
(env -u ANTHROPIC_API_KEY claude plugin validate --strict .claude-plugin/marketplace.json)
(env -u ANTHROPIC_API_KEY claude plugin validate --strict neorion)
```

The npm view check currently returns E404 for the fully unpublished package. The registry lists three historical versions, `0.0.1`, `0.0.2`, and `0.0.3`. Stop if the public record has changed and review availability before publishing.

```sh
release_dir=$(mktemp -d)
export release_dir
(
  cd neorion || exit 1
  npm pack --dry-run &&
  npm publish --dry-run --registry=https://registry.npmjs.org/ &&
  npm pack --pack-destination "$release_dir"
)
tar -tvzf "$release_dir/neorion-0.5.0.tgz"
(
  export HOME="$release_dir/smoke-home"
  export npm_config_cache="$release_dir/smoke-cache"
  mkdir -p "$HOME"
  npm install --global --offline --ignore-scripts --prefix "$release_dir/smoke-prefix" "$release_dir/neorion-0.5.0.tgz" &&
  test "$("$release_dir/smoke-prefix/bin/neorion" --version)" = 0.5.0
)
```

Check for both CLI bundles, the skill, the plugin and MCP manifests, and the license notices. A dry run checks packaging and skips the authenticated registry write. The previous owner’s full unpublish is public, while a new owner’s permission to claim the unscoped name remains unverified. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)

## 3. Publish the inspected tarball

```sh
npm publish "$release_dir/neorion-0.5.0.tgz" --access public --registry=https://registry.npmjs.org/
```

If npm rejects the unscoped name for ownership or name policy, use `@<npm-user>/neorion` under the account from `npm whoami`. Change `neorion/package.json` and the marketplace’s `plugins[0].source.package`, retain `publishConfig.access: "public"`, update the versioned npm references in the root and npm package READMEs and this runbook, then review and push the changes to the feature branch and repeat the checks with the scoped name and resulting tarball. The CLI command, Claude plugin ID, and Codex MCP server name stay `neorion`. [npm scope documentation](https://docs.npmjs.com/cli/v11/using-npm/scope/)

## 4. Verify from the public registry

```sh
npm view neorion@0.5.0 version dist.integrity --registry=https://registry.npmjs.org/
local_integrity=$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  console.log("sha512-" + createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"));
' "$release_dir/neorion-0.5.0.tgz")
test "$(npm view neorion@0.5.0 dist.integrity --registry=https://registry.npmjs.org/)" = "$local_integrity"
(
  verify_dir=$(mktemp -d)
  cd "$verify_dir" || exit 1
  export HOME="$verify_dir/home"
  export npm_config_cache="$verify_dir/cache"
  export npm_config_registry=https://registry.npmjs.org/
  mkdir -p "$HOME"
  test "$(npx --yes neorion@0.5.0 --version)" = 0.5.0 || exit 1
  printf '{}\n' > tsconfig.json
  printf 'export const Example = 1;\n' > example.ts
  npx --yes neorion@0.5.0 graph &&
  npx --yes neorion@0.5.0 query search Example
)
```

Continue after the integrity check and both CLI commands succeed.

## 5. Merge PR #2 to the default branch

GitHub currently uses `master` as the default branch. PR #2 is a draft targeting `fix/graph-quality-and-packaging`. After reviewing the prerequisite PR, merge it with a merge commit to preserve the shared history. Skip these commands if PR #1 has already landed.

```sh
gh pr checks 1 --watch
gh pr merge 1 --merge
```

Retarget PR #2 and review its diff. Run the merge after confirming the base, changes, and required checks.

```sh
gh pr edit 2 --base master
gh pr diff 2
gh pr ready 2
gh pr checks 2 --watch
gh pr merge 2 --squash
git fetch origin master
git show origin/master:.claude-plugin/marketplace.json
```

Verify marketplace install from a clean Claude configuration after the merge. Node.js must be on PATH.

```sh
(
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  export CLAUDE_CONFIG_DIR="$(mktemp -d)"
  claude plugin marketplace add jaminitachi/Neorion &&
  claude plugin install neorion@neorion
)
```

## 6. Tag the release

Find the merged release commit on `master` and verify its package version and marketplace pin before tagging.

```sh
git log --first-parent -n 10 --oneline origin/master
printf '%s' 'Merged release commit SHA: '
read -r release_commit
git merge-base --is-ancestor "$release_commit" origin/master &&
git show "${release_commit}:neorion/package.json" &&
git show "${release_commit}:.claude-plugin/marketplace.json"
```

```sh
git tag -a v0.5.0 "$release_commit" -m "Neorion 0.5.0"
git push origin refs/tags/v0.5.0
```

## User installation

Run the CLI from the project directory.

```sh
npx -y neorion@0.5.0 graph
```

In Claude Code, run:

```text
/plugin marketplace add jaminitachi/Neorion
/plugin install neorion@neorion
```

For Codex, run the setup and start a new Codex session in your project.

```sh
npx -y neorion@0.5.0 setup codex
codex mcp list
```

## Rollback

Deprecate the affected version to warn users. Fix the issue in a new version and update the marketplace pin and installation commands. If a previous good version exists, move `latest` back to it while preparing the fix. The marketplace uses a pinned version, so update or remove its affected entry separately.

```sh
npm deprecate neorion@0.5.0 "This version has been withdrawn. See https://github.com/jaminitachi/Neorion for updates."
```

For a newly created package, the first 72 hours allow unpublishing if no public npm packages depend on it. After 72 hours, npm also requires fewer than 300 downloads in the previous week and a single maintainer. Unpublishing is permanent, burns the version, and triggers a 24-hour waiting period before a new version can be published if it removes the entire package. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)

```sh
npm unpublish neorion@0.5.0
```
