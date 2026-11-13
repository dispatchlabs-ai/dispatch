"""Upgrade a store written by schema 1 (before stores recorded a version) to the current schema.

  engine.py convert --data-dir DIR [--bundle-root DIR] [--clock-kind KIND] [--runtime DISPATCH,PI_DURABLE]

The schema-1 file is opened read-only and is kept, renamed to `assessments.schema1.sqlite`. Every row is carried
over with its ID, so assessment history, frozen requirements, versions, runs and comparisons keep their links and
nothing has to be graded again. What moves:

- `conversations` becomes `units`. Its identifying and time columns keep their meaning; every other column becomes
  an entry of the unit's `labels` JSON under the column's own name, so no domain attribute is a column any more.
- `turn_index`/`turn_id` become `part`/`part_ref`, `prompt_hash` becomes `request_hash`, and the grader recorded in
  `model` becomes `grader`.
- The cycle log `runs` becomes `cycles`; `eval_runs`, `eval_results` and `eval_comparisons` become `runs`, `results`
  and `comparisons`.
- Bundle paths under `--bundle-root` (default: the data directory) become relative to the data directory.
- Any other table is carried over unchanged under its own name.

Schema 1 recorded neither a clock kind nor a runtime identity for a run. Converted runs therefore refuse speed
comparison unless `--clock-kind` declares what the clock was. `--runtime` records a runtime identity in the run
manifest for reference; it does not affect comparisons. A declaration is recorded as made at conversion.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

from dispatch_eval import core as E

UNIT_COLUMNS = {"cid": "unit_id", "first_at": "first_at", "updated_at": "updated_at", "latest_bundle": "latest_bundle", "row_source": "source"}
RENAMED = {"conversations": "units", "runs": "cycles", "eval_runs": "runs", "eval_results": "results", "eval_comparisons": "comparisons"}
KNOWN = {"conversations", "bundles", "requirements", "assessments", "versions", "failures", "runs", "eval_runs", "eval_results", "eval_comparisons"}


def columns(con: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in con.execute(f'pragma table_info("{table}")')]


def convert(data_dir: Path, bundle_root: Path, clock_kind: str | None, runtime: dict | None) -> dict:
    source = data_dir / E.STORE_FILE
    kept = data_dir / "assessments.schema1.sqlite"
    target = data_dir / "assessments.schema2.tmp.sqlite"
    if not source.exists():
        raise SystemExit(f"no store at {source}")
    old = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    old.row_factory = sqlite3.Row
    found = E.store_schema(old)
    if found == E.SCHEMA_VERSION:
        raise SystemExit(f"{source} already uses schema {E.SCHEMA_VERSION}; nothing to convert")
    if found != 1 or "conversations" not in E.tables(old):
        raise SystemExit(f"{source} is not a schema-1 store")
    if kept.exists():
        raise SystemExit(f"{kept} already exists; a previous conversion kept it. Move it aside before converting again.")
    target.unlink(missing_ok=True)
    new = sqlite3.connect(target)
    os.chmod(target, 0o600)
    new.executescript(E.DDL)
    names = E.tables(old)
    counts: dict[str, int] = {}

    def has(table: str) -> bool:
        return table in names

    def carry(table: str, to: str, select: str, width: int) -> None:
        rows = old.execute(select).fetchall()
        new.executemany(f"insert into {to} values({','.join('?' * width)})", [tuple(r) for r in rows])
        counts[to] = len(rows)

    # units: every non-structural column becomes a label under its own name.
    unit_columns = columns(old, "conversations")
    label_columns = [c for c in unit_columns if c not in UNIT_COLUMNS]
    units = []
    for r in old.execute("select * from conversations"):
        labels = {c: r[c] for c in label_columns if r[c] is not None}
        units.append((r["cid"], r["first_at"], r["updated_at"], r["latest_bundle"], r["row_source"] if "row_source" in unit_columns else None, E.canon(labels)))
    new.executemany("insert into units values(?,?,?,?,?,?)", units)
    counts["units"] = len(units)

    def rebased(path: str | None) -> str | None:
        if not path:
            return path
        p = Path(path)
        return str(p.relative_to(bundle_root)) if p.is_absolute() and p.is_relative_to(bundle_root) else path
    bundles = [(r["bundle_id"], r["cid"], r["collected_at"], rebased(r["path"]), r["coverage"], r["release"], r["n_turns"])
               for r in old.execute("select * from bundles")] if has("bundles") else []
    new.executemany("insert into bundles values(?,?,?,?,?,?,?)", bundles)
    counts["bundles"] = len(bundles)
    if has("requirements"):
        carry("requirements", "requirements", "select id, cid, turn_index, prompt_hash, extraction_version, created_at, value, conversation_ref, model from requirements", 9)
    if has("assessments"):
        legacy = E.canon({"recorded": False, "converted_from_schema": 1})
        rows = old.execute("""select id, cid, turn_index, turn_id, evidence_hash, bundle_id, requirements_id, grading_version, created_at, findings,
            conversation_ref, model, kind, repeat_key, supersedes from assessments""").fetchall()
        new.executemany(f"insert into assessments values({','.join('?' * 16)})", [(*tuple(r), legacy) for r in rows])
        counts["assessments"] = len(rows)
    if has("versions"):
        carry("versions", "versions", "select version, kind, created_at, detail from versions", 4)
    if has("failures"):
        carry("failures", "failures", "select key, at, attempts, error from failures", 4)
    if has("runs"):
        carry("runs", "cycles", "select id, started_at, finished_at, detail from runs", 4)
    declared = []
    if has("eval_runs"):
        rows = []
        for r in old.execute("select run, created_at, manifest, closing, status from eval_runs"):
            manifest = r["manifest"]
            if clock_kind or runtime:
                m = json.loads(manifest)
                if clock_kind and not m.get("clock_kind"):
                    m["clock_kind"] = clock_kind
                    m.setdefault("declared_at_conversion", []).append("clock_kind")
                if runtime and not m.get("runtime"):
                    m["runtime"] = runtime
                    m.setdefault("declared_at_conversion", []).append("runtime")
                manifest = E.canon(m)
                declared.append(r["run"])
            rows.append((r["run"], r["created_at"], manifest, r["closing"], r["status"]))
        new.executemany("insert into runs values(?,?,?,?,?)", rows)
        counts["runs"] = len(rows)
    if has("eval_results"):
        carry("eval_results", "results", "select run, case_id, rep, unit_id, state, detail from eval_results", 6)
    if has("eval_comparisons"):
        carry("eval_comparisons", "comparisons", "select a, b from eval_comparisons", 2)

    # Anything else the store holds is kept as it is, under its own name.
    carried = []
    current = E.tables(new)
    for name, sql in old.execute("select name, sql from sqlite_master where type='table' and name not like 'sqlite_%'").fetchall():
        if name in KNOWN:
            continue
        if name in current:
            raise SystemExit(f"schema-1 table {name} has the name of a schema-{E.SCHEMA_VERSION} table; rename it before converting")
        new.execute(sql)
        width = len(columns(old, name))
        rows = old.execute(f'select * from "{name}"').fetchall()
        new.executemany(f'insert into "{name}" values({",".join("?" * width)})', [tuple(r) for r in rows])
        for (index_sql,) in old.execute("select sql from sqlite_master where type='index' and tbl_name=? and sql is not null", (name,)):
            new.execute(index_sql)
        counts[name] = len(rows)
        carried.append(name)

    # Every schema-1 row must have arrived before the files are swapped.
    for table in names - {"sqlite_sequence"}:
        if table.startswith("sqlite_"):
            continue
        before = old.execute(f'select count(*) from "{table}"').fetchone()[0]
        after = new.execute(f'select count(*) from "{RENAMED.get(table, table)}"').fetchone()[0]
        if before != after:
            new.close()
            target.unlink()
            raise SystemExit(f"conversion stopped: {table} has {before} rows but {RENAMED.get(table, table)} received {after}; the store is unchanged")
    meta = {"schema_version": str(E.SCHEMA_VERSION), "converted_at": E.iso(E.now_utc()), "converted_from_schema": "1",
            "converted_source_sha256": E.sha(source.read_bytes()), "converted_label_columns": E.canon(label_columns)}
    new.executemany("insert into store_meta values(?,?)", list(meta.items()))
    new.commit()
    new.close()
    old.close()
    os.rename(source, kept)
    os.rename(target, source)
    for suffix in ("-wal", "-shm"):  # the read-only source left none of its own; a stale pair must not attach to the new file
        stale = Path(str(source) + suffix)
        if stale.exists():
            os.rename(stale, str(kept) + suffix)
    return {"converted": str(source), "kept": str(kept), "schema": E.SCHEMA_VERSION, "rows": dict(sorted(counts.items())),
            "labels_from_columns": label_columns, "carried_tables": carried, "runs_with_declarations": declared,
            "bundle_paths_relative": sum(1 for b in bundles if b[3] and not Path(b[3]).is_absolute())}


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(prog="engine.py convert", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", required=True, help="the use case's data directory (holds assessments.sqlite)")
    ap.add_argument("--bundle-root", help="directory the schema-1 bundle paths were written under (default: --data-dir)")
    ap.add_argument("--clock-kind", help="declare the clock kind of every converted run that recorded none")
    ap.add_argument("--runtime", help="declare DISPATCH_REVISION,PI_DURABLE_VERSION for every converted run that recorded none")
    a = ap.parse_args(argv)
    data = Path(a.data_dir).resolve()
    runtime = None
    if a.runtime:
        try:
            dispatch, pi_durable = a.runtime.split(",")
        except ValueError:
            raise SystemExit("--runtime takes DISPATCH_REVISION,PI_DURABLE_VERSION")
        runtime = {"dispatch": dispatch, "pi_durable": pi_durable}
    json.dump(convert(data, Path(os.path.normpath(a.bundle_root)) if a.bundle_root else data, a.clock_kind, runtime), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
