#!/usr/bin/env python3
"""Assert that the safety nets are actually wired up.

A harness that only runs when somebody remembers to run it is not a check,
and neither is a CI job that quietly stopped covering something. Every
assertion below exists because deleting six lines from a workflow, or
re-narrowing one glob in the root package.json, would otherwise be a silent
loss of coverage that no test in this repo would notice.

Run it anywhere:

    pip install pyyaml
    python3 .github/scripts/check-ci-wiring.py

What it checks
  1. Every workflow file parses as YAML.
  2. No two jobs anywhere share a display name (two "test" jobs in a required
     check list are indistinguishable in the UI and in branch protection).
  3. No job can never trigger: an `if:` guarded on github.event_name has to be
     satisfiable by one of its own workflow's triggers.
  4. Each of the four Phase-4 harnesses runs in a job on every push.
  5. The root `typecheck` script reaches every workspace package that has a
     typecheck script — the bug this file was written after was `--filter
     './packages/**' --filter './apps/**'`, which silently skipped
     examples/live-check, examples/soak and security/.
  6. The root `test` script still means what ci.yml expects of it.
"""

from __future__ import annotations

import fnmatch
import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - environment problem, not a finding
    sys.exit("this checker needs PyYAML: pip install pyyaml")

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((REPO / ".github" / "workflows").glob("*.y*ml"))

# The Phase-4 harnesses, and the command each job must run. Substring match on
# the step's script: the workflows wrap these in `set -euo pipefail` and add
# reporters/flags, but the command itself has to be literally present.
HARNESSES = {
    "viewer e2e (41 Playwright tests)": "pnpm --filter viewer test:e2e",
    "secret-leak audit": "pnpm --filter security-audit test",
    "soak battery": "pnpm --filter soak start",
    "live-check harness": "pnpm --filter live-check start",
}

problems: list[str] = []


def fail(message: str) -> None:
    problems.append(message)
    print(f"::error::{message}")


def load(path: Path) -> dict | None:
    try:
        document = yaml.safe_load(path.read_text())
    except yaml.YAMLError as error:
        fail(f"{path.relative_to(REPO)} is not valid YAML: {error}")
        return None
    if not isinstance(document, dict):
        # An empty or truncated file parses fine and defines nothing, which is
        # the quietest way a workflow can stop existing.
        fail(f"{path.relative_to(REPO)} parses to nothing — an empty workflow file runs nothing")
        return None
    return document


def triggers(workflow: dict) -> set[str]:
    """`on:` is the YAML 1.1 boolean `True` once PyYAML is done with it."""
    raw = workflow.get("on", workflow.get(True))
    if isinstance(raw, dict):
        return set(raw)
    if isinstance(raw, list):
        return set(raw)
    if isinstance(raw, str):
        return {raw}
    return set()


EVENT_CLAUSE = re.compile(r"github\.event_name\s*(==|!=)\s*'([^']+)'")


def can_trigger(condition: object, events: set[str]) -> bool:
    """Is there an event this workflow fires on that satisfies `if:`?

    Deliberately narrow: it understands a FLAT chain of github.event_name
    comparisons joined by all-`||` or all-`&&`, which is every guard this repo
    has ever written. Anything richer — parentheses, negation, a mix of
    operators, a condition mentioning anything but github.event_name — is
    assumed satisfiable. Guessing wrong in that direction costs nothing; the
    other direction would be a false failure on a workflow that is fine.
    """
    if condition is None:
        return True
    text = str(condition).replace("${{", "").replace("}}", "")
    if not EVENT_CLAUSE.search(text):
        return True  # guarded on something other than the event; assume it can fire
    skeleton = EVENT_CLAUSE.sub("X", text)
    if re.sub(r"[X\s]|\|\||&&", "", skeleton):
        return True  # parens, `!`, or some other term: do not pretend to evaluate it
    if "||" in skeleton and "&&" in skeleton:
        return True  # mixed precedence; not worth reimplementing
    combine = any if "||" in skeleton else all
    for event in events:
        results = [
            (event == value) if operator == "==" else (event != value)
            for operator, value in EVENT_CLAUSE.findall(text)
        ]
        if combine(results):
            return True
    return False


def run_scripts(job: dict) -> list[str]:
    return [step["run"] for step in job.get("steps", []) or [] if isinstance(step, dict) and "run" in step]


# --------------------------------------------------------------------------
# 1 + 2 + 3: the workflow set is coherent
# --------------------------------------------------------------------------
workflows: dict[Path, dict] = {}
for path in WORKFLOWS:
    document = load(path)
    if document is not None:
        workflows[path] = document

if not workflows:
    fail("no workflows parsed — .github/workflows is empty or every file is broken")

display_names: dict[str, list[str]] = {}
for path, document in workflows.items():
    events = triggers(document)
    if not events:
        fail(f"{path.relative_to(REPO)} declares no triggers, so nothing in it can ever run")
    for job_id, job in (document.get("jobs") or {}).items():
        where = f"{path.relative_to(REPO)}:{job_id}"
        name = str(job.get("name", job_id))
        display_names.setdefault(name, []).append(where)
        if not can_trigger(job.get("if"), events):
            fail(
                f"{where} can never run: `if: {job.get('if')}` is not satisfiable by "
                f"any of this workflow's triggers ({', '.join(sorted(events))})"
            )

for name, locations in sorted(display_names.items()):
    if len(locations) > 1 and "${{" not in name:
        fail(f"two jobs share the display name {name!r}: {', '.join(locations)} — they are indistinguishable in required checks")

# --------------------------------------------------------------------------
# 4: every harness runs on push
# --------------------------------------------------------------------------
def pushes_on_branches(document: dict) -> bool:
    """A `push` trigger that fires for ordinary commits, not only for tags.

    publish-python.yml is `on: push: tags: ['v*']` — real, but it runs on a
    release tag, so a harness parked there would not run on a normal push.
    """
    raw = document.get("on", document.get(True))
    if not isinstance(raw, dict):
        return "push" in triggers(document)
    if "push" not in raw:
        return False
    spec = raw["push"]
    if not isinstance(spec, dict):
        return True  # bare `push:` — every branch, every tag
    return "tags" not in spec and "tags-ignore" not in spec


on_push: list[str] = []
for path, document in workflows.items():
    if not pushes_on_branches(document):
        continue
    for job_id, job in (document.get("jobs") or {}).items():
        if not can_trigger(job.get("if"), {"push"}):
            continue
        on_push.extend(run_scripts(job))

push_scripts = "\n".join(on_push)
for label, command in HARNESSES.items():
    if command not in push_scripts:
        fail(f"the {label} does not run on push: no job triggered by push runs `{command}`")

# --------------------------------------------------------------------------
# 5 + 6: the root scripts reach what they claim to reach
# --------------------------------------------------------------------------
root = json.loads((REPO / "package.json").read_text())
scripts = root.get("scripts", {})

workspace = yaml.safe_load((REPO / "pnpm-workspace.yaml").read_text())
projects: dict[str, dict] = {}
for pattern in workspace.get("packages", []):
    for manifest in sorted(REPO.glob(f"{pattern}/package.json")):
        if "node_modules" in manifest.parts:
            continue
        projects[manifest.parent.relative_to(REPO).as_posix()] = json.loads(manifest.read_text())

if not projects:
    fail("found no workspace projects — the pnpm-workspace.yaml globs did not match anything")

FILTER = re.compile(r"--filter\s+'([^']+)'|--filter\s+\"([^\"]+)\"|--filter\s+(\S+)")


def selected(script: str) -> set[str] | None:
    """Which project dirs a `pnpm -r ... run X` script selects.

    None means "no --filter at all", i.e. the whole workspace.

    Models the two selector forms these scripts use: a path glob (pnpm treats
    a filter starting `./` or `../` as a path) and a package-name glob. A
    dependency selector — `pkg...`, `...pkg`, `pkg^...` — is not modelled; if
    a root script ever grows one, teach this function about it rather than
    believing the failure it produces.
    """
    filters = [next(g for g in match if g) for match in FILTER.findall(script)]
    if not filters:
        return None
    path_filters = [f for f in filters if f.startswith("./") or f.startswith("../")]
    name_filters = [f for f in filters if f not in path_filters]
    chosen = set()
    for directory, manifest in projects.items():
        name = manifest.get("name", "")
        if any(fnmatch.fnmatch(directory, p.removeprefix("./")) for p in path_filters):
            chosen.add(directory)
        elif any(fnmatch.fnmatch(name, p) for p in name_filters):
            chosen.add(directory)
    return chosen


want_typecheck = {d for d, m in projects.items() if "typecheck" in (m.get("scripts") or {})}
covered = selected(scripts.get("typecheck", ""))
if covered is not None:
    missed = sorted(want_typecheck - covered)
    if missed:
        fail(
            "the root `typecheck` script does not reach "
            + ", ".join(missed)
            + " — they have a typecheck script that nothing runs. Widen the filters, or drop them "
            "so `pnpm -r run typecheck` covers the whole workspace."
        )

# What ci.yml's "Test packages and viewer" step relies on `pnpm test` meaning.
want_test = {d for d, m in projects.items() if d.startswith("packages/") and "test" in (m.get("scripts") or {})}
if "apps/viewer" in projects:
    want_test.add("apps/viewer")
covered_test = selected(scripts.get("test", ""))
if covered_test is not None:
    missed = sorted(want_test - covered_test)
    if missed:
        fail(
            "the root `test` script no longer covers " + ", ".join(missed) + " — ci.yml runs "
            "`pnpm test` as its only unit-test step and CONTRIBUTING pins it as the contributor gate"
        )

# --------------------------------------------------------------------------
print()
print(f"workflows parsed:    {len(workflows)}")
print(f"jobs:                {sum(len(d.get('jobs') or {}) for d in workflows.values())}")
print(f"workspace projects:  {len(projects)}")
print(f"typechecked:         {len(want_typecheck)}")
for label, command in HARNESSES.items():
    print(f"on every push:       {label} -> {command}")

if problems:
    print(f"\n{len(problems)} problem(s)")
    sys.exit(1)
print("\nCI wiring OK")
