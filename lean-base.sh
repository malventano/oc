#!/usr/bin/env bash
# Regenerate the lean oc base snapshot from an upstream opencode tag.
#
# Usage: lean-base.sh <upstream-tag> [<upstream-commit>]
#   e.g.  lean-base.sh v1.18.14 65cf14df16
#
# Creates (or replaces) branch oc-lean as an ORPHAN commit containing only the
# upstream paths listed below. The patch series is applied on top with `git am`
# and the result is force-pushed to the oc remote as main. Force-push is the
# normal update path for this repo (main is a derived artifact).
#
# Requirement: the upstream tag must be present locally
#   git fetch <upstream> tag <tag>
set -euo pipefail

TAG="${1:?usage: lean-base.sh <upstream-tag> [<upstream-commit>]}"
COMMIT="${2:-}"
if [ -z "$COMMIT" ]; then
  COMMIT="$(git rev-parse --verify "refs/tags/$TAG" 2>/dev/null || git rev-parse --verify "$TAG")"
fi
BRANCH="oc-lean"

# Everything from the upstream tree that is kept. Everything else (CI, dogfood
# config, community docs, nix/sst/deploy tooling, translations, demo artifacts)
# is stripped. Add paths here if a future upstream release needs new build inputs.
EXCLUDES=(README.*.md .github .opencode .husky .vscode .zed artifacts bugs github infra install nix perf sdks specs \
  AGENTS.md CONTEXT.md CONTRIBUTING.md SECURITY.md STATS.md flake.nix flake.lock sst.config.ts sst-env.d.ts screenshot-uk.png)

git branch -D "$BRANCH" 2>/dev/null || true
git checkout -q --orphan "$BRANCH"
git rm -rfq . 2>/dev/null || true
git read-tree "$COMMIT"
git checkout -q -- .
git rm -rfq --ignore-unmatch "${EXCLUDES[@]}"

# Build input carve-out: @opencode-ai/script reads .github/TEAM_MEMBERS at module load
# (packages/script/src/index.ts:51), and packages/opencode/script/build.ts imports it.
git checkout "$COMMIT" -- .github/TEAM_MEMBERS
git add .github/TEAM_MEMBERS

# Our AGENTS.md stub replaces upstream's (which is excluded above).
cat > AGENTS.md << 'EOF'
# oc

oc is a custom fork of opencode (anomalyco/opencode) maintained as a lean snapshot of an
upstream release plus a patch series. See README.md for the build procedure and the
patch summary.

- `main` is a derived artifact: it is regenerated from the current upstream tag
  (see lean-base.sh) plus the patch series maintained by the owner. Force-pushes are
  the normal update path.
- Custom opencode plugins and plugin tools for the build live in `plugins/` and `tools/`
  (see their READMEs).
EOF

git add AGENTS.md
git commit -qm "oc base: anomalyco/opencode $TAG ($COMMIT), lean snapshot"

echo "oc-lean ready from $TAG ($COMMIT). Apply the patch series next:"
echo "  git am <patches-dir>/*.patch"
