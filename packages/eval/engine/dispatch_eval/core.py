"""Evaluation core: the store, versions, answer parsing, comparison rule, repeat agreement and build identity.

Nothing here knows about any company, agent or domain.

- Store: one append-only SQLite assessment history per use case (frozen requirements, assessments, versions),
  with an explicit schema version.
- Versions: extraction and grading versions hash the rubric text, the grader model/settings and the prompt/schema
  versions; a change makes a new version and new linked rows, and unchanged work is reused.
- Answers: closed JSON in a ```json fence.
- Comparison: a change is clear only when one side's range lies wholly outside the other's.
- Agreement: repeated judgments of the same unit, compared item by item over the union of items.
- Build identity: which release produced a row, and whether that build was a clean commit.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

SCHEMA_VERSION = 2
STORE_FILE = "assessments.sqlite"


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def canon(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------- store

# A unit is whatever the use case evaluates. Its domain attributes are JSON in `labels`; no column names a domain.
# A unit with numbered parts (for example the turns of a conversation) uses `part`; a unit without parts uses part 0.
DDL = """
create table if not exists store_meta(key text primary key, value text);
create table if not exists units(unit_id text primary key, first_at text, updated_at text, latest_bundle text,
  source text, labels text);
create table if not exists bundles(bundle_id text primary key, unit_id text, collected_at text, path text,
  coverage text, identity text, parts int);
create table if not exists requirements(id integer primary key, unit_id text, part int, request_hash text,
  extraction_version text, created_at text, value text, conversation_ref text, grader text,
  unique(unit_id, part, request_hash, extraction_version));
create table if not exists assessments(id integer primary key, unit_id text, part int, part_ref text,
  evidence_hash text, bundle_id text, requirements_id int, grading_version text, created_at text, findings text,
  conversation_ref text, grader text, kind text, repeat_key text, supersedes int, build text);
create unique index if not exists assessment_identity on assessments(unit_id, part, evidence_hash, grading_version,
  requirements_id, kind, repeat_key);
create table if not exists versions(version text primary key, kind text, created_at text, detail text);
create table if not exists failures(key text primary key, at text, attempts int, error text);
create table if not exists cycles(id integer primary key, started_at text, finished_at text, detail text);
create table if not exists runs(run text primary key, created_at text, manifest text, closing text, status text);
create table if not exists results(run text, case_id text, rep int, unit_id text, state text, detail text,
  primary key(run, case_id, rep));
create table if not exists comparisons(a text, b text, primary key(a, b));
"""


def tables(con: sqlite3.Connection) -> set[str]:
    return {r[0] for r in con.execute("select name from sqlite_master where type='table'")}


def store_schema(con: sqlite3.Connection) -> int | None:
    """The store's schema version: None for an empty database, 1 for a store written before versions were recorded."""
    names = tables(con)
    if "store_meta" in names:
        row = con.execute("select value from store_meta where key='schema_version'").fetchone()
        if row:
            return int(row[0])
    return 1 if names else None


def open_store(data_dir: str | Path) -> sqlite3.Connection:
    """Open (or create) the use case's store. A store on another schema version is refused, never altered."""
    Path(data_dir).mkdir(parents=True, exist_ok=True, mode=0o700)
    path = Path(data_dir) / STORE_FILE
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    found = store_schema(con)
    if found is None:
        con.executescript(DDL)
        con.execute("insert into store_meta values('schema_version', ?)", (str(SCHEMA_VERSION),))
        con.execute("insert into store_meta values('created_at', ?)", (iso(now_utc()),))
        con.commit()
        os.chmod(path, 0o600)
    elif found == 1:
        con.close()
        raise SystemExit(f"{path} uses store schema 1. Convert it first: dispatch-eval convert --data-dir {data_dir}")
    elif found != SCHEMA_VERSION:
        con.close()
        raise SystemExit(f"{path} uses store schema {found}; this engine reads and writes schema {SCHEMA_VERSION}.")
    return con


def bundle_path(data_dir: str | Path, stored: str) -> Path:
    """Bundle paths inside the data directory are stored relative to it, so a store can be moved or copied whole."""
    p = Path(stored)
    return p if p.is_absolute() else Path(data_dir) / p


@contextlib.contextmanager
def inspection_copy(source: str | Path):
    """A temporary private copy of a SQLite store (and its -wal/-shm files) for inspection.

    The directory is created 0700 and each file 0600, and the copy is removed when the block ends, whether it
    succeeded or failed. Yields the path of the copied database; the original is never opened."""
    source = Path(source)
    directory = Path(tempfile.mkdtemp(prefix="dispatch-eval-inspect-"))
    try:
        os.chmod(directory, 0o700)
        copied = directory / source.name
        for suffix in ("", "-wal", "-shm"):
            original = Path(str(source) + suffix)
            if original.exists():
                target = Path(str(copied) + suffix)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as out, open(original, "rb") as src:
                    shutil.copyfileobj(src, out)
        yield copied
    finally:
        shutil.rmtree(directory, ignore_errors=True)
        if directory.exists():
            raise RuntimeError(f"could not remove the temporary inspection copy at {directory}")


# ---------------------------------------------------------------- versions

def rubric_versions(extract: Path, judge: Path, grader: str, prompt_version: int, schema_version: int) -> tuple[str, str]:
    """(extraction version, grading version). The formula is fixed: stored versions must not move."""
    ex = sha(Path(extract).read_bytes() + f"|{grader}|p{prompt_version}".encode())[:12]
    jd = sha(Path(judge).read_bytes() + f"|{grader}|p{prompt_version}|s{schema_version}".encode())[:12]
    return f"x-{ex}", f"g-{jd}"


def record_versions(con, extract: Path, judge: Path, grader: str, prompt_version: int, schema_version: int,
                    metric_version: str) -> tuple[str, str]:
    ex, jd = rubric_versions(extract, judge, grader, prompt_version, schema_version)
    for v, kind, f in ((ex, "extract", extract), (jd, "judge", judge)):
        con.execute("insert or ignore into versions values(?,?,?,?)", (v, kind, iso(now_utc()), canon(
            {"grader": grader, "instructions_sha256": sha(Path(f).read_bytes()), "prompt_version": prompt_version,
             "schema_version": schema_version, "metric_version": metric_version})))
    con.commit()
    return ex, jd


# ---------------------------------------------------------------- answers

def parse_json_answer(text: str) -> dict:
    fenced = re.search(r"```json\s*(.*?)```", text, re.S)
    raw = fenced.group(1) if fenced else text[text.find("{"): text.rfind("}") + 1]
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("answer is not a JSON object")
    return value


# ---------------------------------------------------------------- comparison

def clear_change(before: list, after: list, higher_is_better: bool = True) -> str:
    """A change is clear only when one side's range lies wholly outside the other's; no fixed threshold."""
    if not before or not after:
        return "not comparable"
    if min(after) > max(before):
        return "better" if higher_is_better else "worse"
    if max(after) < min(before):
        return "worse" if higher_is_better else "better"
    return "no clear change"


def majority(flags) -> bool | None:
    return None if not flags else sum(bool(x) for x in flags) * 2 > len(flags)


def mode(values):
    return Counter(values).most_common(1)[0][0] if values else ""


def verdict(primary: str, secondary: str, d0: bool | None, d1: bool | None, done0: str, done1: str) -> str:
    """One part's verdict from a primary and a secondary measure, a defect flag and completion (failed is worst)."""
    if done0 == "failed" and done1 not in ("failed", ""):
        return "better"
    if done1 == "failed" and done0 not in ("failed", ""):
        return "worse"
    signals = [primary, secondary, "better" if d0 and d1 is False else "worse" if d1 and d0 is False else "no clear change"]
    good, bad = signals.count("better"), signals.count("worse")
    if primary == "not comparable" and secondary == "not comparable":
        return "not comparable"
    return "better" if good and not bad else "worse" if bad and not good else "mixed" if good and bad else "no clear change"


def speed_comparability(a: str, clock_a: str | None, b: str, clock_b: str | None) -> str | None:
    """Why seconds from two runs must not be compared, or None when both recorded the same clock kind."""
    missing = [run for run, kind in ((a, clock_a), (b, clock_b)) if not kind]
    if missing:
        return f"clock kind not recorded for {' and '.join(missing)}; seconds measured by an unknown clock are not compared"
    if clock_a != clock_b:
        return f"clock kinds differ ({a}: {clock_a}; {b}: {clock_b}); seconds measured by different clocks are not compared"
    return None


def runtime_comparability(a: str, runtime_a: dict | None, b: str, runtime_b: dict | None) -> str | None:
    """Why two runs are not comparable by runtime identity (Dispatch revision and Pi Durable version), or None."""
    def known(r):
        return bool(r and r.get("dispatch") and r.get("pi_durable"))

    def text(r):
        return f"Dispatch {r.get('dispatch')}, Pi Durable {r.get('pi_durable')}"
    missing = [run for run, r in ((a, runtime_a), (b, runtime_b)) if not known(r)]
    if missing:
        return f"runtime identity not recorded for {' and '.join(missing)}"
    if (runtime_a["dispatch"], runtime_a["pi_durable"]) != (runtime_b["dispatch"], runtime_b["pi_durable"]):
        return f"different runtime identities ({a}: {text(runtime_a)}; {b}: {text(runtime_b)})"
    return None


# ---------------------------------------------------------------- agreement

def agreement(units: list[list[dict]], label=lambda key: key, noun: str = "units") -> dict:
    """Repeat agreement over closed items. `units` holds each unit's judgments, already flattened to {item: value}.
    The union of items is compared: an item missing from one judgment counts as a disagreement."""
    items = flips = n = 0
    flipped: dict[str, int] = {}
    for flat in units:
        if len(flat) < 2:
            continue
        n += 1
        for k in set.union(*(set(d) for d in flat)):
            items += 1
            if len({json.dumps(d.get(k, "(absent)"), sort_keys=True) for d in flat}) > 1:
                flips += 1
                flipped[label(k)] = flipped.get(label(k), 0) + 1
    if not n:
        return {}
    return {"units": n, "items": items, "flips": flips, "agreement": round(1 - flips / items, 3) if items else None, "flipped": flipped,
            "summary": f"{n} {noun} repeated; {items - flips}/{items} closed items identical ({round(100 * (1 - flips / items)) if items else 0}%)"}


# ---------------------------------------------------------------- build identity

CLEAN_REVISION = re.compile(r"^[0-9a-f]{7,64}$")
DEVELOPMENT = "DEVELOPMENT EVIDENCE"


def revision_dirty(revision: str | None) -> bool:
    """A revision that is not a plain commit hash (a `-dirty` suffix, `uncommitted`, or nothing) is not a clean build."""
    return not (revision and CLEAN_REVISION.match(revision))


def build_identity() -> dict:
    """The build that is running this engine, as the launcher recorded it in DISPATCH_EVAL_BUILD.

    {"recorded": true, "release", "definitions": {"revision", "dirty"}, "dispatch": {"revision", "version", "dirty"},
    "pi_durable", "roots": [directories whose content is part of the release]}; {"recorded": false} when the engine
    was started without the launcher."""
    raw = os.environ.get("DISPATCH_EVAL_BUILD")
    if not raw:
        return {"recorded": False}
    value = json.loads(raw)
    for part in ("definitions", "dispatch"):
        value[part] = {**(value.get(part) or {}), "dirty": revision_dirty((value.get(part) or {}).get("revision"))}
    return {**value, "recorded": True}


def package_identity(directory: Path, release_roots: list[str]) -> dict:
    """Where a use-case package's files come from: the release's definitions, a Git checkout, or neither.
    Its content hash is recorded in every case."""
    files = sorted(p for p in directory.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    digest = hashlib.sha256()
    for f in files:
        digest.update(str(f.relative_to(directory)).encode() + b"\0" + hashlib.sha256(f.read_bytes()).digest())
    out = {"sha256": digest.hexdigest()[:16]}
    if any(directory.is_relative_to(Path(root).resolve()) for root in release_roots):
        return {**out, "source": "release"}
    try:
        git = lambda *args: subprocess.run(["git", "-C", str(directory), *args], check=True, capture_output=True, text=True).stdout.strip()  # noqa: E731
        return {**out, "source": "git", "commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain", "--", "."))}
    except (OSError, subprocess.CalledProcessError):
        return {**out, "source": "unversioned", "dirty": True}


def by_reason(found: list[tuple[str, str]]) -> list[str]:
    """(source, reason) pairs as one line per reason, naming every source that has it."""
    sources: dict[str, list[str]] = {}
    for source, reason in found:
        if source not in sources.setdefault(reason, []):
            sources[reason].append(source)
    return [f"{reason} ({', '.join(where)})" for reason, where in sources.items()]


def development_reasons(build: dict | None) -> list[str]:
    """Why work done by this build is development evidence, not release evidence. Empty for a clean recorded build."""
    if not build:
        return []
    if build.get("converted_from_schema"):
        return []  # recorded before builds were tracked; reports name these rows separately
    if not build.get("recorded"):
        return ["build identity not recorded (engine started without the launcher)"]
    reasons = []
    if (build.get("definitions") or {}).get("dirty"):
        reasons.append(f"definitions revision {(build.get('definitions') or {}).get('revision') or 'unknown'} is not a clean commit")
    if (build.get("dispatch") or {}).get("dirty"):
        reasons.append(f"Dispatch revision {(build.get('dispatch') or {}).get('revision') or 'unknown'} is not a clean commit")
    package = build.get("package") or {}
    if package.get("source") == "unversioned":
        reasons.append("use-case package is neither in the release nor in a Git checkout")
    elif package.get("dirty"):
        reasons.append(f"use-case package has uncommitted changes (commit {package.get('commit')})")
    return reasons
