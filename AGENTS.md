# oc

oc is a custom fork of opencode (anomalyco/opencode) maintained as a lean snapshot of an
upstream release plus a patch series. See README.md for the build procedure and the
patch summary.

- `main` is a derived artifact: it is regenerated from the current upstream tag
  (see lean-base.sh) plus the patch series maintained by the owner. Force-pushes are
  the normal update path.
- Custom opencode plugins and plugin tools for the build live in `plugins/` and `tools/`
  (see their READMEs).
