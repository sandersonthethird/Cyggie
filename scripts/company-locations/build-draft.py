#!/usr/bin/env python3
"""
build-draft.py — merge the workflow's per-batch result files with the
worklist snapshot into a single reviewable draft.csv.

  worklist.json  : current DB values per company (id, name, domain, website,
                   industry, city, state)
  results/*.json : workflow output per company
                   (id, name, city, state, country, website, domain,
                    industry, confidence, source, notes)

Output: draft.csv with current_* columns (what's already in the DB) alongside
the proposed values, plus an `action` column the reviewer edits
(apply / review / skip). Only gaps are ever proposed; existing values show in
the current_* columns and are never overwritten by the apply step.
"""
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORKLIST = os.path.join(HERE, "worklist.json")
RESULTS_DIR = os.path.join(HERE, "results")
OUT = os.path.join(HERE, "draft.csv")

COLUMNS = [
    "id", "name",
    "current_domain", "current_website", "current_industry",
    "current_city", "current_state",
    "city", "state", "country", "website", "domain", "industry",
    "confidence", "source", "notes", "action",
]


def norm(v):
    if v is None:
        return ""
    return str(v).strip()


def main():
    worklist = {c["id"]: c for c in json.load(open(WORKLIST))}

    # Load + validate every result file.
    results = {}
    missing_files = []
    bad_files = []
    for i in range(200):  # generous upper bound; stop when files run out
        p = os.path.join(RESULTS_DIR, f"batch-{i:02d}.json")
        if not os.path.exists(p):
            break
        try:
            rows = json.load(open(p))
            for r in rows:
                results[r["id"]] = r
        except Exception as e:  # noqa: BLE001
            bad_files.append((p, str(e)))

    # Report coverage.
    covered = set(results)
    all_ids = set(worklist)
    uncovered = sorted(all_ids - covered, key=lambda i: worklist[i]["name"])
    if bad_files:
        print("MALFORMED result files (re-run these batches):", file=sys.stderr)
        for p, e in bad_files:
            print(f"  {p}: {e}", file=sys.stderr)
    if uncovered:
        print(f"WARNING: {len(uncovered)} companies have no result row:", file=sys.stderr)
        for cid in uncovered[:30]:
            print(f"  {worklist[cid]['name']} ({cid})", file=sys.stderr)

    rows_out = []
    counts = {"apply": 0, "review": 0, "skip": 0}
    for cid, cur in sorted(worklist.items(), key=lambda kv: kv[1]["name"].lower()):
        res = results.get(cid, {})
        conf = norm(res.get("confidence"))

        # Proposed values, but ONLY for fields currently empty in the DB.
        def gap(field, res_key):
            if norm(cur.get(field)):
                return ""  # already populated → never propose
            return norm(res.get(res_key))

        prop_city = gap("city", "city")
        prop_state = gap("state", "state")
        prop_website = gap("website", "website")
        prop_domain = gap("domain", "domain")
        prop_industry = gap("industry", "industry")

        has_change = any([prop_city, prop_state, prop_website, prop_domain, prop_industry])

        if not res:
            action = "skip"  # no data at all
        elif conf == "low":
            action = "review"
        elif not has_change:
            action = "skip"  # nothing new to add
        else:
            action = "apply"  # high / med / foreign with gaps to fill
        counts[action] = counts.get(action, 0) + 1

        rows_out.append({
            "id": cid,
            "name": cur.get("name", ""),
            "current_domain": norm(cur.get("domain")),
            "current_website": norm(cur.get("website")),
            "current_industry": norm(cur.get("industry")),
            "current_city": norm(cur.get("city")),
            "current_state": norm(cur.get("state")),
            "city": prop_city,
            "state": prop_state,
            "country": norm(res.get("country")),
            "website": prop_website,
            "domain": prop_domain,
            "industry": prop_industry,
            "confidence": conf,
            "source": norm(res.get("source")),
            "notes": norm(res.get("notes")),
            "action": action,
        })

    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        w.writerows(rows_out)

    print(f"Wrote {OUT}: {len(rows_out)} rows")
    print(f"  action=apply : {counts.get('apply', 0)}")
    print(f"  action=review: {counts.get('review', 0)}  (low confidence)")
    print(f"  action=skip  : {counts.get('skip', 0)}  (no data / nothing new)")
    if uncovered or bad_files:
        print(f"  coverage gaps: {len(uncovered)} uncovered, {len(bad_files)} malformed files")


if __name__ == "__main__":
    main()
