<!--
  Provenance: Drafted by Claude (Anthropic) from a working conversation with
  Jeff, September 2026. Agent-generated reference doc — edit freely.
-->

# PR Templates — how this repo's templates actually get picked up

This file explains *why* the templates live where they do, so the next person
(including future-you, or an agent) doesn't "clean up" the layout and break
something silently. It is not the templates themselves — see:

- `docs/pull_request_template.md` — default template, used on every PR unless overridden

## Why `docs/`

`docs/` is one of the few folder names recognized as a template location by
**both** Azure Repos and GitHub. Put the file there once and it keeps working
if this repo ever migrates from Azure DevOps to GitHub — no re-homing step,
no silent window where PRs stop getting a template.

`.azuredevops/` (Azure-only) and `.github/` (GitHub-only, also the folder the
EUD Toolkit overwrites at work) both work on their one platform but require a
manual move on migration. `docs/` sidesteps both problems.

## Azure Repos

- **Default template:** `docs/pull_request_template.md`. Auto-populates the
  PR description on every new PR unless a branch-specific template applies.
- **Branch-specific template:** `docs/pull_request_template/branches/<name>.md`.
  Azure matches on the **first segment** of the source branch name — a file
  named `hotfix.md` applies to any `hotfix/*` branch, `develop.md` to any
  `develop/*` branch, etc. If no branch-specific file matches, the default
  template is used.
- **Additional (author-picked) templates:** `docs/pull_request_template/<name>.md`,
  offered as a dropdown when creating the PR.
- All template files must live in the repo's **default branch** — templates
  committed only to a feature branch are ignored.

`[DECIDE]` — whether to add a `docs/pull_request_template/branches/hotfix.md`
override, or keep one flat template with a hotfix section inside it (current
choice, see next section for why).

## GitHub

- **Default template:** GitHub looks for `pull_request_template.md` in the
  repo root, `docs/`, or `.github/` — so the same `docs/pull_request_template.md`
  file above is picked up with zero changes.
- **No branch-specific auto-selection.** This is the one real gap versus Azure
  Repos — GitHub has no mechanism to auto-apply a different template based on
  the PR's target or source branch.
- **Multiple templates (manual choice only):** `.github/PULL_REQUEST_TEMPLATE/*.md`
  (or the same subfolder under `docs/` or root) gives the *author* a picker via
  `?template=name.md` in the PR creation URL. Nothing selects one automatically.

## Why one flat template, not a branch-specific hotfix override

Azure's branch-specific auto-selection has no GitHub equivalent. If this repo
is ever migrated, a `pull_request_template/branches/hotfix.md` file doesn't
error out — it just becomes an inert file in `docs/`, and every PR silently
falls back to the default template with no warning that the hotfix-specific
questions stopped being asked.

Current approach: **one template, with a hotfix section marked
"delete if not applicable."** This behaves identically on both platforms,
today and after any future migration, at the cost of the author having to
delete a section by hand instead of it never appearing.

If Azure-only branch auto-selection is worth the migration risk later, revisit
this — it's a reversible choice, not an architectural one.

## Gitea note (homelab repos only)

Gitea uses the same single-default-template model as GitHub, but recognizes
only repo root, `.gitea/`, or `.github/` — **not `docs/`**. A repo hosted on
Gitea needs the template mirrored into `.gitea/pull_request_template.md` (or
`.github/`) to take effect; `docs/pull_request_template.md` alone will not be
picked up there.