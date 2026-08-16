# Release checklist

This document is for maintainers. It is intentionally separate from the product README.

## Source of truth

- [ ] The GitHub repository is the canonical source.
- [ ] The local branch is based on the current GitHub default branch.
- [ ] No Pod, private checkout, or generated copy is treated as an upstream source.
- [ ] The worktree is clean before tagging.

## Product behavior

- [ ] Project and user `.claude` discovery matches the documented fixed-root behavior.
- [ ] Explicit Skill symlinks resolve successfully, including targets outside `.claude`.
- [ ] Rules, Skills, command Hooks, and Agents retain their documented precedence.
- [ ] `.dsn` adaptations do not modify Claude source assets.
- [ ] Known compatibility gaps remain documented accurately.

## Security and privacy

- [ ] No credentials, tokens, private paths, internal hostnames, or private project identifiers are present.
- [ ] Hook execution and explicit external references are described in the security section.
- [ ] Configuration rejects absolute discovery directories and directory traversal.
- [ ] The package contains only intended runtime files and declared bundled dependencies.

## Verification

```sh
npm ci
npm test
npm run build
node --input-type=module -e "const m = await import('./lib/index.js'); if (m.name !== 'dsh-claude-in' || typeof m.apply !== 'function') process.exit(1)"
npm pack --dry-run
git diff --check
```

- [ ] Tests pass on a supported Node.js version.
- [ ] The built entry imports successfully.
- [ ] The package dry run contains the expected files only.
- [ ] The release tarball installs and imports in an isolated directory.

## GitHub release

- [ ] `package.json` version and Git tag match.
- [ ] The release points to the intended commit.
- [ ] The repository topics include `dsh-plugin` and `deepseek-harness-plugin`.
- [ ] Release notes describe user-facing changes without internal audit commentary.
- [ ] A prebuilt tarball is attached when install-time build permission should be avoidable.
- [ ] Default-branch SHA, tag target, Release assets, and repository topics are verified from GitHub after publishing.
