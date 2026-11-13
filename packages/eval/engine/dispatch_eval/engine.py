#!/usr/bin/env python3
"""Evaluation engine: one use-case package plus its private bindings.

A package is a directory with `eval.json` (name, unit, rubric files and versions, grader, module, judgments, clock)
and a Python module that supplies the use-case-specific parts:

  collect(ctx) -> [unit]                 retained runs -> units (no agent is rerun)
  cases(ctx) -> [case]; run_case(ctx, run, case, variant, rep) -> unit     controlled reruns (optional)
  target_identity(ctx, variant) -> {...}                                   what a rerun runs against (optional)
  extract_prompt(unit) / judge_prompt(unit, requirements)
  validate_extract(value) / validate_judge(value, requirements)
  metrics(findings, requirements, unit) -> {name: number|bool|str}
  closed_items(findings) -> {item: value}      repeat agreement
  measures -> [(label, metric, higher_is_better)]    comparison measures (first is primary)
  report_columns -> [(header, width, fn(row) -> value)]   extra Units columns

A unit is {"unit_id", "request", "evidence", "observed": {seconds, tokens, cost_usd, models}, "coverage", "labels"},
optionally with "first_at" and "requirements_key". Requirements are extracted from `request` only (never the outcome)
and frozen by its hash; judgments see `request` and `evidence`. Unchanged evidence keeps its assessments.

  engine.py --package DIR --bindings FILE  collect | plan | ingest | fail | status | agreement | publish | report
                                           plan-run | search | run-ids | compare | runs
  engine.py convert --data-dir DIR [--bundle-root DIR] [--clock-kind KIND] [--runtime DISPATCH,PI_DURABLE]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dispatch_eval import core as E  # noqa: E402
from dispatch_eval.workbook import Publisher  # noqa: E402

RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Package:
    def __init__(self, directory: str, bindings: str):
        self.dir = Path(directory).resolve()
        self.manifest = json.loads((self.dir / "eval.json").read_text())
        self.bindings = json.loads(Path(bindings).read_text())
        self.bindings_file = str(Path(bindings).resolve())
        for k in ("dataDir", "workbook"):
            if not str(self.bindings.get(k, "")).startswith("/"):
                raise SystemExit(f"bindings: {k} must be an absolute path")
        spec = importlib.util.spec_from_file_location(f"usecase_{self.manifest['name'].replace('-', '_')}", self.dir / self.manifest["module"])
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        r = self.manifest["rubric"]
        self.extract, self.judge = self.dir / r["extract"], self.dir / r["judge"]
        self.prompt_version, self.schema_version, self.metric_version = r["prompt_version"], r["schema_version"], r["metric_version"]
        self.data = Path(self.bindings["dataDir"])
        self.con = E.open_store(self.data)
        build = E.build_identity()
        self.build = {**build, "package": E.package_identity(self.dir, build.get("roots") or [])}

    def ctx(self) -> dict:
        # `records` is the command (argv) of the read-only native record reader; `inspection_copy` makes a private
        # temporary copy of a store that is removed when its `with` block ends.
        records = os.environ.get("DISPATCH_EVAL_RECORDS")
        return {"package": str(self.dir), "bindings": self.bindings, "bindings_file": self.bindings_file, "data": str(self.data),
                "records": json.loads(records) if records else None, "inspection_copy": E.inspection_copy, "build": self.build}

    def versions(self, grader: str) -> tuple[str, str]:
        return E.record_versions(self.con, self.extract, self.judge, grader, self.prompt_version, self.schema_version, self.metric_version)

    def stamp(self) -> dict:
        """The build recorded on each assessment and run: enough to tell release evidence from development evidence."""
        b = self.build
        return {"recorded": bool(b.get("recorded")), "release": b.get("release"),
                "definitions": (b.get("definitions") or {}).get("revision"), "dispatch": (b.get("dispatch") or {}).get("revision"),
                "pi_durable": b.get("pi_durable"), "package": b.get("package"), "development": E.development_reasons(b)}

    def runtime(self) -> dict | None:
        b = self.build
        if not b.get("recorded"):
            return None
        return {"dispatch": (b.get("dispatch") or {}).get("revision"), "pi_durable": b.get("pi_durable")}


def uid_of(raw: str) -> str:
    return re.sub(r"[^A-Za-z0-9_:-]", "_", raw)[:120]


def req_key(unit: dict) -> str:
    """Frozen requirements belong to the request, not the run: units that share a request (the same case in several
    reruns) share one extraction through `requirements_key`; otherwise each unit has its own."""
    return uid_of(unit.get("requirements_key") or unit["unit_id"])


def input_hash(unit: dict) -> str:
    return E.sha(E.canon(unit["request"]))[:16]


def evidence_hash(unit: dict) -> str:
    return E.sha(E.canon({"request": unit["request"], "evidence": unit["evidence"]}))[:16]


# ---------------------------------------------------------------- units

def store_unit(p: Package, unit: dict, source: str) -> str:
    unit = {**unit, "unit_id": uid_of(unit["unit_id"])}
    uid = unit["unit_id"]
    body = E.canon(unit)
    bundle_id = E.sha(body.encode())[:20]
    p.con.execute("""insert into units(unit_id,first_at,updated_at,source,labels) values(?,?,?,?,?)
        on conflict(unit_id) do update set updated_at=excluded.updated_at, labels=excluded.labels""",
                  (uid, unit.get("first_at"), E.iso(E.now_utc()), source, E.canon(unit.get("labels") or {})))
    if not p.con.execute("select 1 from bundles where bundle_id=?", (bundle_id,)).fetchone():
        relative = Path("units") / uid.replace(":", "_") / f"{bundle_id}.json"
        f = p.data / relative
        f.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        f.write_text(body)
        f.chmod(0o600)
        p.con.execute("insert into bundles values(?,?,?,?,?,?,?)", (bundle_id, uid, E.iso(E.now_utc()), str(relative), E.canon(unit.get("coverage") or ["full"]),
                      E.canon(unit.get("identity") or {}), 1))
    p.con.execute("update units set latest_bundle=? where unit_id=?", (bundle_id, uid))
    p.con.commit()
    return uid


def units(p: Package, ids: list[str] | None = None) -> list[dict]:
    out = []
    for r in p.con.execute("select u.unit_id, b.path from units u join bundles b on b.bundle_id=u.latest_bundle order by u.first_at, u.unit_id"):
        if ids and r["unit_id"] not in ids:
            continue
        out.append(json.loads(E.bundle_path(p.data, r["path"]).read_text()))
    return out


def collect(p: Package, limit: int | None) -> dict:
    found = p.m.collect({**p.ctx(), "limit": limit})
    before = {r[0] for r in p.con.execute("select latest_bundle from units")}
    ids = [store_unit(p, u, "collect") for u in found]
    after = {r[0] for r in p.con.execute("select latest_bundle from units where unit_id in (%s)" % ",".join("?" * len(ids)), ids)} if ids else set()
    return {"units": len(ids), "new_or_changed": len(after - before), "ids": ids}


# ---------------------------------------------------------------- grading (the plan/ingest/fail protocol of grading.ts)

def plan(p: Package, grader: str, ids: list[str] | None, repeats: int, extract_only: bool) -> list[dict]:
    ex, jd = p.versions(grader)
    work = p.data / "work"
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    items, extracting = [], set()
    for u in units(p, ids):
        if u.get("gradable") is False:
            continue
        uid, ih, eh, rk_ = u["unit_id"], input_hash(u), evidence_hash(u), req_key(u)
        req = p.con.execute("select id, value from requirements where unit_id=? and part=0 and request_hash=? and extraction_version=?", (rk_, ih, ex)).fetchone()
        if not req:
            if (rk_, ih) in extracting:
                continue  # one extraction per request, even when several units share it
            extracting.add((rk_, ih))
            key = f"{uid}.0.extract.{ex}.{ih}"
            items.append({"key": key, "step": "extract", "instructions": str(p.extract), "prompt": write(work, key, p.m.extract_prompt(u))})
            continue
        if extract_only:
            continue
        for rk in ([f"r{k}" for k in range(1, repeats + 1)] if repeats else [""]):
            kind = "repeat" if rk else "primary"
            if p.con.execute("select 1 from assessments where unit_id=? and part=0 and evidence_hash=? and grading_version=? and requirements_id=? and kind=? and repeat_key=?",
                             (uid, eh, jd, req["id"], kind, rk)).fetchone():
                continue
            key = f"{uid}.0.judge.{jd}.{eh}.q{req['id']}" + (f".{rk}" if rk else "")
            items.append({"key": key, "step": "judge", "instructions": str(p.judge), "prompt": write(work, key, p.m.judge_prompt(u, json.loads(req["value"])))})
    return items


def write(work: Path, key: str, text: str) -> str:
    f = work / f"{key}.prompt.md"
    f.write_text(text)
    f.chmod(0o600)
    return str(f)


def ingest(p: Package, grader: str, key: str, answer: str, conversation: str) -> dict:
    ex, jd = p.versions(grader)
    parts = key.split(".")
    uid, step, version = parts[0], parts[2], parts[3]
    if version not in (ex, jd):
        raise SystemExit(f"stale work item {key}: current versions are {ex}, {jd}")
    value = E.parse_json_answer(Path(answer).read_text())
    u = units(p, [uid])[0]
    if step == "extract":
        p.m.validate_extract(value)
        p.con.execute("insert or ignore into requirements(unit_id,part,request_hash,extraction_version,created_at,value,conversation_ref,grader) values(?,?,?,?,?,?,?,?)",
                      (req_key(u), 0, parts[4], ex, E.iso(E.now_utc()), E.canon(value), conversation, grader))
        p.con.commit()
        return {"stored": "requirements", "key": key}
    eh, req_id, rk = parts[4], int(parts[5][1:]), (parts[6] if len(parts) > 6 else "")
    req = p.con.execute("select id, value from requirements where id=?", (req_id,)).fetchone()
    if not req or evidence_hash(u) != eh:
        raise SystemExit(f"stale work item {key}: the unit's evidence or requirements changed")
    p.m.validate_judge(value, json.loads(req["value"]))
    kind = "repeat" if rk else "primary"
    prior = p.con.execute("select id from assessments where unit_id=? and kind='primary' order by id desc limit 1", (uid,)).fetchone()
    cur = p.con.execute("""insert or ignore into assessments(unit_id,part,part_ref,evidence_hash,bundle_id,requirements_id,grading_version,created_at,
        findings,conversation_ref,grader,kind,repeat_key,supersedes,build) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (uid, 0, uid, eh, p.con.execute("select latest_bundle from units where unit_id=?", (uid,)).fetchone()[0], req["id"], jd,
                   E.iso(E.now_utc()), E.canon(value), conversation, grader, kind, rk, prior["id"] if prior and kind == "primary" else None,
                   E.canon({**p.stamp(), "metric_version": p.metric_version})))
    p.con.commit()
    if not cur.rowcount:
        # Only the identical assessment (same unit, evidence, requirements, version, kind and repeat) can already exist.
        return {"stored": "already", "key": key}
    return {"stored": kind, "key": key}


def fail(p: Package, key: str, error: str) -> dict:
    p.con.execute("insert into failures values(?,?,1,?) on conflict(key) do update set at=excluded.at, attempts=attempts+1, error=excluded.error",
                  (key, E.iso(E.now_utc()), error[:500]))
    p.con.commit()
    return {"recorded": key}


# ---------------------------------------------------------------- results

def grader_of(p: Package) -> str:
    g = p.manifest["grader"]
    return f"{g['provider']}/{g['id']}/{g['thinking']}"


def judged_rows(p: Package, u: dict, versions: tuple[str, str] | None = None) -> list:
    """The stored judgments of the unit's current evidence under the given (extraction, grading) versions, by default
    the package's current ones. Only the current cohort: this evidence, this grading version, and the frozen
    requirements for this exact request under this extraction version. Earlier extractions' judgments stay in the
    history, never in the report."""
    ex, jd = versions or E.rubric_versions(p.extract, p.judge, grader_of(p), p.prompt_version, p.schema_version)
    return p.con.execute("""select a.findings, a.build, r.value rv from assessments a join requirements r on r.id=a.requirements_id
            where a.unit_id=? and a.evidence_hash=? and a.grading_version=? and r.unit_id=? and r.request_hash=? and r.extraction_version=?
            order by a.kind, a.repeat_key""", (u["unit_id"], evidence_hash(u), jd, req_key(u), input_hash(u), ex)).fetchall()


def judged(p: Package, u: dict, versions: tuple[str, str] | None = None) -> list[tuple[dict, dict, dict]]:
    """(findings, requirements, metrics) for each judgment of the unit's current evidence. Metrics are computed here,
    in code, from the closed findings; nothing numeric comes from the grader."""
    out = []
    for a in judged_rows(p, u, versions):
        f, r = json.loads(a["findings"]), json.loads(a["rv"])
        out.append((f, r, p.m.metrics(f, r, u)))
    return out


def evidence_class(p: Package) -> dict:
    """Whether anything in this store, or the build reading it, is development evidence, and why. Every report
    carries the answer."""
    found = [("the build that produced this report", x) for x in E.development_reasons(p.build)]
    for r in p.con.execute("select run, manifest from runs order by created_at"):
        found += [(f"run {r['run']}", x) for x in json.loads(r["manifest"]).get("development") or []]
    unrecorded = 0
    for row in p.con.execute("select build, count(*) n from assessments group by build"):
        build = json.loads(row["build"]) if row["build"] else None
        if not build or build.get("converted_from_schema"):
            unrecorded += row["n"]
        else:
            found += [(f"the build that graded {row['n']} assessments", x) for x in build.get("development") or []]
    reasons = E.by_reason(found)
    return {"class": "development" if reasons else "release", "reasons": reasons, "assessments_without_recorded_build": unrecorded,
            "label": f"{E.DEVELOPMENT}: {'; '.join(reasons)}. " if reasons else ""}


def unit_class(p: Package, u: dict) -> str:
    builds = [json.loads(a["build"]) if a["build"] else None for a in judged_rows(p, u)]
    if any(b and b.get("development") for b in builds):
        return "development"
    if any(not b or b.get("converted_from_schema") for b in builds):
        return "build not recorded"
    return "release" if builds else ""


def status(p: Package) -> dict:
    us = units(p)
    counts = Counter(len(judged(p, u)) for u in us)
    ev = evidence_class(p)
    return {"package": p.manifest["name"], "units": len(us), "judgments_per_unit": {str(k): v for k, v in sorted(counts.items())},
            "requirements": p.con.execute("select count(*) from requirements").fetchone()[0],
            "failures": p.con.execute("select count(*) from failures").fetchone()[0],
            "schema_version": E.SCHEMA_VERSION, "evidence_class": ev["class"], "evidence_reasons": ev["reasons"],
            "assessments_without_recorded_build": ev["assessments_without_recorded_build"]}


def agreement(p: Package) -> dict:
    return E.agreement([[p.m.closed_items(f) for f, _, _ in judged(p, u)] for u in units(p)])


def utc_text(value) -> str | None:
    """A recorded time as compact UTC text ("2026-01-31 17:28")."""
    if not value:
        return None
    import datetime as dt
    try:
        t = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    return (t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)).astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M")


def rng(v: list):
    v = [x for x in v if x is not None]
    if not v:
        return None
    if all(isinstance(x, bool) for x in v):
        return f"{sum(v)}/{len(v)} yes"
    return v[0] if min(v) == max(v) else f"{min(v)}–{max(v)}"


# ---------------------------------------------------------------- reruns

def plan_run(p: Package, run: str, variant: dict, repeats: int, cases: list[str]) -> dict:
    if not RUN_ID.match(run):
        raise SystemExit("run IDs use letters, digits, '-' and '_' only")
    clock = (p.manifest.get("clock") or {}).get("kind")
    if not clock:
        raise SystemExit("eval.json needs clock.kind (what observed.seconds measures) before a run can be planned")
    if not p.bindings.get("billingRoute"):
        raise SystemExit("bindings: billingRoute must say which credentials pay for target and grader calls")
    all_cases = p.m.cases(p.ctx())
    chosen = [c for c in all_cases if not cases or c["id"] in cases]
    target = p.m.target_identity(p.ctx(), variant) if hasattr(p.m, "target_identity") else None
    stamp = p.stamp()
    manifest = {"variant": variant, "repeats": repeats, "cases": [c["id"] for c in chosen], "cases_sha256": E.sha(E.canon(chosen))[:16],
                "case_inputs": chosen,  # the exact inputs; a resumed run uses these, never the current case file
                "grader": grader_of(p), "judgments": p.manifest.get("judgments", 3), "package": p.manifest["name"],
                "rubric": [str(x) for x in E.rubric_versions(p.extract, p.judge, grader_of(p), p.prompt_version, p.schema_version)],
                "metric_version": p.metric_version, "billing": p.bindings.get("billingRoute"), "started_at": E.iso(E.now_utc()),
                "target_identity": target, "clock_kind": clock,
                # The runtime the run belongs to: the target's own when it reports one, otherwise this build's.
                "runtime": (target or {}).get("runtime") or p.runtime(),
                "definitions": {"revision": stamp["definitions"], "dirty": E.revision_dirty(stamp["definitions"])},
                "build": stamp, "development": stamp["development"]}
    if not p.con.execute("select 1 from runs where run=?", (run,)).fetchone():
        p.con.execute("insert into runs values(?,?,?,?,?)", (run, E.iso(E.now_utc()), E.canon(manifest), None, "planned"))
        for c in chosen:
            for rep in range(1, repeats + 1):
                p.con.execute("insert or ignore into results values(?,?,?,?,?,?)", (run, c["id"], rep, None, "pending", "{}"))
        p.con.commit()
    return run_status(p, run)


def search(p: Package, run: str) -> dict:
    """Run every pending (case, repeat) through the use case's target. A finished result is never redone."""
    import concurrent.futures as cf
    r = p.con.execute("select * from runs where run=?", (run,)).fetchone()
    if not r:
        raise SystemExit(f"run {run} is not planned; plan it with plan-run first")
    manifest = json.loads(r["manifest"])
    pending = [tuple(x) for x in p.con.execute("select case_id, rep from results where run=? and state='pending'", (run,))]
    if manifest.get("case_inputs") is not None:
        cases = {c["id"]: c for c in manifest["case_inputs"]}
    else:  # runs planned before inputs were retained: only if the current cases are byte-identical to the planned ones
        current = [c for c in p.m.cases(p.ctx()) if c["id"] in manifest["cases"]]
        if pending and E.sha(E.canon(current))[:16] != manifest["cases_sha256"]:
            raise SystemExit(f"run {run}: its cases changed since planning and their planned contents were not retained; plan a new run")
        cases = {c["id"]: c for c in current}
    if pending and hasattr(p.m, "target_identity"):
        # New target calls only against the planned target: a changed snapshot, definition or variant is drift.
        now_identity = p.m.target_identity(p.ctx(), manifest["variant"])
        planned = manifest.get("target_identity") or {}
        drift = sorted(k for k in set(planned) | set(now_identity) if k not in ("release",) and planned.get(k) != now_identity.get(k))
        if drift:
            raise SystemExit(f"run {run}: target drifted since planning ({', '.join(drift)}); finished cases are kept; plan a new run for the rest")
    if pending:
        known = manifest.get("development") or []
        added = [x for x in (f"continued by a development build: {r}" for r in E.development_reasons(p.build))
                 if x not in known and x.removeprefix("continued by a development build: ") not in known]
        if added:
            manifest["development"] = known + added
            p.con.execute("update runs set manifest=? where run=?", (E.canon(manifest), run))
            p.con.commit()

    def one(case_id, rep):
        # Workers only run the target; every store write happens on this thread's connection below.
        return case_id, rep, p.m.run_case(p.ctx(), run, cases[case_id], manifest["variant"], rep)

    out = []
    with cf.ThreadPoolExecutor(max_workers=p.bindings.get("concurrency") or max(1, len(pending))) as ex:
        futures = {ex.submit(one, cid, rep): (cid, rep) for cid, rep in pending}
        for f in cf.as_completed(futures):
            case_id, rep = futures[f]
            try:
                _, _, unit = f.result()
            except Exception as e:  # stays pending; the next search retries it
                out.append((case_id, rep, f"error: {str(e)[:300]}"))
                continue
            uid = store_unit(p, unit, f"run {run}")
            p.con.execute("update results set unit_id=?, state=?, detail=? where run=? and case_id=? and rep=?",
                          (uid, unit.get("state", "done"), E.canon({"observed": unit.get("observed")}), run, case_id, rep))
            p.con.commit()
            out.append((case_id, rep, unit.get("state", "done")))
    p.con.execute("update runs set status=? where run=?", ("searched" if not any(o[2].startswith("error") for o in out) else "incomplete", run))
    p.con.commit()
    return {"run": run, "attempted": len(pending), "outcomes": out}


def run_ids(p: Package, run: str | None) -> dict:
    ids = [x[0] for x in p.con.execute("select unit_id from results where run=? and unit_id is not null", (run,))] if run else None
    return {"ids": ids or [], "all": not run, "repeats": max(0, p.manifest.get("judgments", 3) - 1)}


def run_status(p: Package, run: str) -> dict:
    r = p.con.execute("select * from runs where run=?", (run,)).fetchone()
    return {"run": run, "status": r["status"] if r else "unknown",
            "states": dict(Counter(x[0] for x in p.con.execute("select state from results where run=?", (run,))))}


def compare(p: Package, a: str, b: str) -> list[list]:
    """Run against run over the planned case population: clear only when ranges (search repeats x judgments) separate.
    Each run is read under its own recorded rubric versions. Runs with different rubric, grader or metric versions
    are not comparable. Seconds are compared only when both runs recorded the same clock kind. The runtime a run
    recorded is shown, and never decides whether two runs are compared. Coverage (completed, failed, pending, unassessed) is shown for both."""
    ra, rb = (p.con.execute("select * from runs where run=?", (x,)).fetchone() for x in (a, b))
    for name, row in ((a, ra), (b, rb)):
        if not row:
            raise SystemExit(f"run {name} is not in this store")
    ma, mb = json.loads(ra["manifest"]), json.loads(rb["manifest"])

    def side(run, m):
        versions = tuple(m["rubric"])
        cov, out = Counter(), {}
        for case_id, rep, uid, state in p.con.execute("select case_id, rep, unit_id, state from results where run=?", (run,)):
            u = units(p, [uid]) if uid else []
            js = judged(p, u[0], versions) if u else []
            cov["pending" if state == "pending" else "assessed" if js else "failed" if state not in ("done",) else "unassessed"] += 1
            out.setdefault(case_id, []).append((u[0] if u else None, js))
        return out, cov
    A, cov_a = side(a, ma)
    B, cov_b = side(b, mb)
    metric_now = p.metric_version
    reasons = []
    if ma["rubric"] != mb["rubric"] or ma["grader"] != mb["grader"]:
        reasons.append("different rubric or grader versions")
    if ma.get("metric_version") != mb.get("metric_version"):
        reasons.append(f"different metric versions ({ma.get('metric_version')} vs {mb.get('metric_version')})")
    if ma.get("metric_version") == mb.get("metric_version") and metric_now != ma.get("metric_version"):
        reasons.append(f"the package now computes metric version {metric_now}; the runs recorded {ma.get('metric_version')} / {mb.get('metric_version')}")
    comparable = not reasons
    measures = p.m.measures
    rows = []
    for case_id in sorted(set(A) | set(B)):
        x, y = A.get(case_id, []), B.get(case_id, [])
        vals = {}
        for label, metric, hib in measures:
            v0 = [m[metric] for _, js in x for _, _, m in js if m.get(metric) is not None]
            v1 = [m[metric] for _, js in y for _, _, m in js if m.get(metric) is not None]
            vals[label] = (v0, v1, E.clear_change([float(v) for v in v0], [float(v) for v in v1], hib) if comparable else "not comparable")
        t0 = [u["observed"].get("seconds") for u, _ in x if u and (u.get("observed") or {}).get("seconds") is not None]
        t1 = [u["observed"].get("seconds") for u, _ in y if u and (u.get("observed") or {}).get("seconds") is not None]
        rows.append((case_id, vals, t0, t1))
    first = measures[0][0]
    covtxt = lambda c: ", ".join(f"{k} {c[k]}" for k in ("assessed", "failed", "unassessed", "pending") if c[k]) or "none"  # noqa: E731
    block = [[f"COMPARISON {a} -> {b}", ""]]
    development = E.by_reason([(f"run {run}", x) for run, m in ((a, ma), (b, mb)) for x in m.get("development") or []]
                              + [("the build that produced this report", x) for x in E.development_reasons(p.build)])
    if development:
        block.append([E.DEVELOPMENT, "; ".join(development)])
    block += [["Planned cases x repeats: coverage", f"{a}: {covtxt(cov_a)} | {b}: {covtxt(cov_b)}"],
              ["Cases with assessed results on both sides", f"{sum(1 for r in rows if r[1][first][0] and r[1][first][1])} of {len(rows)} planned"]]
    if not comparable:
        block.append(["Comparability", "NOT COMPARABLE: " + "; ".join(reasons)])
    for label, _, _ in measures:
        cnt = Counter(r[1][label][2] for r in rows)
        block.append([f"{label}: better / worse / no clear change / not comparable",
                      " / ".join(str(cnt[k]) for k in ("better", "worse", "no clear change", "not comparable"))])
        v0 = [v for r in rows for v in r[1][label][0]]
        v1 = [v for r in rows for v in r[1][label][1]]
        if v0 or v1:
            block.append([f"{label}: mean over cases x repeats x judgments", f"{round(statistics.mean(v0), 3) if v0 else ''} -> {round(statistics.mean(v1), 3) if v1 else ''}"])
    refused = E.speed_comparability(a, ma.get("clock_kind"), b, mb.get("clock_kind"))
    if refused:
        block.append(["Seconds to outcome: NOT COMPARED", f"REFUSED: {refused}"])
    else:
        s0, s1 = sorted(t for r in rows for t in r[2]), sorted(t for r in rows for t in r[3])
        block.append(["Seconds to outcome: median / slowest (n)", f"{statistics.median(s0) if s0 else ''} / {s0[-1] if s0 else ''} ({len(s0)}) -> "
                                                                  f"{statistics.median(s1) if s1 else ''} / {s1[-1] if s1 else ''} ({len(s1)})"])
        block.append(["Clock kind", ma["clock_kind"]])
    block.append(["Versions", f"{a}: {'/'.join(ma['rubric'])} {ma.get('metric_version')} | {b}: {'/'.join(mb['rubric'])} {mb.get('metric_version')}"])
    diff = [f"{k}: {E.canon(ma.get(k))} -> {E.canon(mb.get(k))}" for k in ("variant", "target_identity", "cases_sha256", "repeats", "billing",
                                                                           "clock_kind", "runtime", "definitions") if ma.get(k) != mb.get(k)]
    block.append(["What differs between the runs", "; ".join(diff) or "nothing recorded"])
    p.con.execute("insert or ignore into comparisons values(?,?)", (a, b))
    p.con.commit()
    return block + [["", ""]]


# ---------------------------------------------------------------- report

def sheets(p: Package) -> tuple[list[dict], dict]:
    """Every report sheet as data, and the agreement summary. A development build or development evidence in the
    store is named at the start of every sheet's note."""
    us = units(p)
    ev = evidence_class(p)
    dev = ev["label"]
    extra = getattr(p.m, "report_columns", [])
    metric_names = sorted({k for u in us for _, _, m in judged(p, u) for k in m})
    rows = []
    for u in us:
        js = judged(p, u)
        o = u.get("observed") or {}
        primary = js[0][0] if js else {}
        rows.append([u["unit_id"], utc_text(u.get("first_at")), (u.get("labels") or {}).get("kind"), (u.get("labels") or {}).get("title"),
                     ", ".join(u.get("coverage") or ["full"]), len(js)]
                    + [rng([m.get(k) for _, _, m in js]) for k in metric_names]
                    + [o.get("seconds"), o.get("tokens"), o.get("cost_usd"), ", ".join(o.get("models") or [])]
                    + [fn({"unit": u, "judgments": js}) for _, _, fn in extra] + [unit_class(p, u), primary.get("summary", "")])
    cols = [("Unit", 30), ("Started (UTC)", 17), ("Kind", 14), ("Title", 36), ("Evidence coverage", 16), ("Judgments", 10)] \
        + [(f"{k} (range over judgments)", 14) for k in metric_names] \
        + [("Seconds to outcome (recorded)", 12), ("Tokens (recorded)", 12), ("Cost USD (recorded rates)", 12), ("Models", 18)] \
        + [(h, w) for h, w, _ in extra] + [("Graded by build", 14), ("Summary (primary judgment)", 60)]
    out = [{"name": "Units", "notes": True, "columns": cols, "rows": rows,
            "note": f"{dev}{p.manifest['name']}: one row per evaluated unit ({p.manifest['unit']}). Ranges are over repeated judgments of the same "
                    "outcome (the grader's variation, not the agent's). Grading is provisional until checked against a person's judgment. "
                    "Cost is recorded token usage at stated rates."}]
    if hasattr(p.m, "findings_columns"):
        frows = []
        if hasattr(p.m, "findings_rows"):
            for u in us:
                frows += p.m.findings_rows(u, judged(p, u))
        out.append({"name": "Findings", "notes": False, "columns": p.m.findings_columns, "rows": frows,
                    "note": f"{dev}Closed findings per judgment, with evidence pointers."})
    ag = agreement(p)
    out.append({"name": "Agreement", "notes": False,
                "note": f"{dev}Repeat agreement: the same unit judged more than once, compared item by item (union of items).",
                "columns": [("Units repeated", 12), ("Closed items", 12), ("Identical", 12), ("Agreement", 12), ("Items that varied", 80)],
                "rows": [[ag.get("units"), ag.get("items"), (ag.get("items") or 0) - (ag.get("flips") or 0), ag.get("agreement"),
                          E.canon(dict(sorted((ag.get("flipped") or {}).items(), key=lambda kv: -kv[1])[:30]))]] if ag else []})
    run_rows = []
    for r in p.con.execute("select * from runs order by created_at").fetchall():
        m = json.loads(r["manifest"])
        rt = m.get("runtime") or {}
        run_rows.append([r["run"], r["status"], E.canon(m["variant"]), m["repeats"], ", ".join(m["cases"]), E.canon(m.get("target_identity")),
                         m.get("billing"), r["created_at"], m.get("clock_kind") or "not recorded",
                         f"Dispatch {rt.get('dispatch')}, Pi Durable {rt.get('pi_durable')}" if rt else "not recorded",
                         (m.get("definitions") or {}).get("revision") or "not recorded",
                         f"{E.DEVELOPMENT}: {'; '.join(m['development'])}" if m.get("development") else "release" if m.get("build") else "not recorded"])
    out.append({"name": "Runs", "notes": True, "rows": run_rows,
                "note": f"{dev}Controlled reruns: one row per run. The variant is the only intended difference.",
                "columns": [("Run", 24), ("Status", 12), ("Variant", 30), ("Repeats", 8), ("Cases", 30), ("Target identity", 50), ("Billing route", 24),
                            ("Started", 20), ("Clock kind", 18), ("Runtime identity", 30), ("Definitions commit", 20), ("Build", 30)]})
    lines = []
    for a, b in p.con.execute("select a, b from comparisons").fetchall():
        lines += compare(p, a, b)
    out.append({"name": "Comparisons", "notes": False, "columns": [("Measure", 60), ("Value", 100)], "rows": lines,
                "note": f"{dev}Run against run: a change is clear only when one run's range across its repeats and judgments lies wholly "
                        "outside the other's. Three judgments measure the grader; repeated runs measure the agent."})
    vers = []
    for r in p.con.execute("select * from versions order by created_at"):
        d = json.loads(r["detail"])
        vers.append([r["version"], r["kind"], utc_text(r["created_at"]), d.get("grader"), (d.get("instructions_sha256") or "")[:16],
                     d.get("prompt_version"), d.get("schema_version"), d.get("metric_version")])
    out.append({"name": "Versions", "notes": False, "rows": vers,
                "note": f"{dev}Every assessment records these versions; a change makes new linked rows. Times are UTC.",
                "columns": [("Version", 18), ("Step", 10), ("First used (UTC)", 18), ("Grader model/settings", 32), ("Rubric sha256 (prefix)", 20),
                            ("Prompt version", 9), ("Schema version", 9), ("Metric version", 9)]})
    return out, ag


def publish(p: Package) -> dict:
    built, ag = sheets(p)
    pub = Publisher(p.bindings["workbook"], ["Comparisons", "Runs", "Units", "Findings", "Agreement", "Versions"])
    for s in built:
        pub.sheet(s["name"], s["note"], [(h, w) for h, w in s["columns"]], s["rows"], notes=s["notes"])
    lines = next(s["rows"] for s in built if s["name"] == "Comparisons")
    return {"workbook": pub.save("Comparisons" if lines else "Units"), "units": len(built[0]["rows"]), "agreement": ag.get("summary"),
            "evidence_class": evidence_class(p)["class"]}


def report(p: Package) -> dict:
    """The same sheets as the workbook, as JSON (no workbook is written)."""
    built, ag = sheets(p)
    ev = evidence_class(p)
    return {"package": p.manifest["name"], "evidence_class": ev["class"], "evidence_reasons": ev["reasons"], "agreement": ag.get("summary"),
            "sheets": [{"name": s["name"], "note": s["note"], "columns": [h for h, _ in s["columns"]], "rows": s["rows"]} for s in built]}


# ---------------------------------------------------------------- CLI

def main() -> None:
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] == "convert":
        from dispatch_eval.convert import main as convert_main
        return convert_main(sys.argv[2:])
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--package", required=True)
    ap.add_argument("--bindings", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("collect")
    sp.add_argument("--limit", type=int)
    sp = sub.add_parser("plan")
    sp.add_argument("--grader", required=True)
    sp.add_argument("--ids", default="")
    sp.add_argument("--repeats", type=int, default=0)
    sp.add_argument("--extract-only", action="store_true")
    sp = sub.add_parser("ingest")
    for k in ("--grader", "--key", "--answer"):
        sp.add_argument(k, required=True)
    sp.add_argument("--conversation", default="")
    sp = sub.add_parser("fail")
    sp.add_argument("--key", required=True)
    sp.add_argument("--error", required=True)
    for name in ("status", "agreement", "publish", "report", "runs"):
        sub.add_parser(name)
    sp = sub.add_parser("plan-run")
    sp.add_argument("--run", required=True)
    sp.add_argument("--variant", default="{}")
    sp.add_argument("--repeats", type=int, default=1)
    sp.add_argument("--cases", default="")
    sp = sub.add_parser("search")
    sp.add_argument("--run", required=True)
    sp = sub.add_parser("run-ids")
    sp.add_argument("--run")
    sp = sub.add_parser("compare")
    sp.add_argument("--runs", required=True)
    a = ap.parse_args()
    p = Package(a.package, a.bindings)
    if a.cmd == "collect":
        res = collect(p, a.limit)
    elif a.cmd == "plan":
        res = plan(p, a.grader, [x for x in a.ids.split(",") if x] or None, a.repeats, a.extract_only)
    elif a.cmd == "ingest":
        res = ingest(p, a.grader, a.key, a.answer, a.conversation)
    elif a.cmd == "fail":
        res = fail(p, a.key, a.error)
    elif a.cmd == "agreement":
        res = agreement(p)
    elif a.cmd == "publish":
        res = publish(p)
    elif a.cmd == "report":
        res = report(p)
    elif a.cmd == "runs":
        res = [dict(r) for r in p.con.execute("select run, status, created_at from runs")]
    elif a.cmd == "plan-run":
        res = plan_run(p, a.run, json.loads(a.variant), a.repeats, [x for x in a.cases.split(",") if x])
    elif a.cmd == "search":
        res = search(p, a.run)
    elif a.cmd == "run-ids":
        res = run_ids(p, a.run)
    elif a.cmd == "compare":
        try:
            x, y = a.runs.split(",")
        except ValueError:
            raise SystemExit("compare --runs takes exactly two run IDs: A,B")
        res = compare(p, x, y)
    else:
        res = status(p)
    json.dump(res, sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
