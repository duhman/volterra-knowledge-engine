#!/usr/bin/env python3
"""
Evaluate deterministic majority-vote categorization against historical labels.

Usage:
  python3 scripts/evaluate-hubspot-categorizer.py --sample-per-sub 100
  python3 scripts/evaluate-hubspot-categorizer.py --full --max-workers 4
"""
import argparse
import json
import os
import random
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

BASE = "https://your-project.supabase.co"


def get_key():
  return (
    os.environ.get("SUPABASE_CLOUD_SERVICE_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
  )


def fetch_labeled_metadata(key, batch_size=1000):
  headers = {
    "Authorization": f"Bearer {key}",
    "apikey": key,
    "Content-Type": "application/json",
    "Accept-Profile": "volterra_kb",
  }
  items = []
  offset = 0
  while True:
    params = {
      "select": "id,category,subcategory",
      "limit": str(batch_size),
      "offset": str(offset),
      "order": "id",
    }
    resp = requests.get(f"{BASE}/rest/v1/training_conversations", headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
      break
    for row in rows:
      sub = (row.get("subcategory") or "").strip()
      if not sub:
        continue
      items.append({
        "id": row["id"],
        "category": (row.get("category") or "").strip() or "General",
        "subcategory": sub,
      })
    if len(rows) < batch_size:
      break
    offset += batch_size
  return items


def sample_by_subcategory(items, per_sub, seed=7):
  rng = random.Random(seed)
  by_sub = defaultdict(list)
  for c in items:
    by_sub[c["subcategory"]].append(c)
  sampled = []
  for sub, rows in by_sub.items():
    if per_sub <= 0 or len(rows) <= per_sub:
      sampled.extend(rows)
    else:
      sampled.extend(rng.sample(rows, per_sub))
  return sampled


def fetch_embeddings_for_ids(key, ids, batch_size=200):
  headers = {
    "Authorization": f"Bearer {key}",
    "apikey": key,
    "Content-Type": "application/json",
    "Accept-Profile": "volterra_kb",
  }
  out = {}
  for i in range(0, len(ids), batch_size):
    chunk = ids[i:i+batch_size]
    if not chunk:
      continue
    id_list = ",".join(chunk)
    params = {
      "select": "id,embedding",
      "id": f"in.({id_list})",
    }
    resp = requests.get(f"{BASE}/rest/v1/training_conversations", headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    rows = resp.json()
    for row in rows:
      if row.get("embedding"):
        out[row["id"]] = row["embedding"]
  return out


def classify(conv, key, match_threshold, match_count):
  headers = {
    "Authorization": f"Bearer {key}",
    "apikey": key,
    "Content-Type": "application/json",
  }
  payload = {
    "query_embedding": conv["embedding"],
    "match_threshold": match_threshold,
    "match_count": match_count,
  }
  r = None
  for attempt in range(3):
    try:
      r = requests.post(
        f"{BASE}/rest/v1/rpc/match_training_conversations",
        headers=headers,
        data=json.dumps(payload),
        timeout=30,
      )
      break
    except requests.RequestException as exc:
      if attempt < 2:
        time.sleep(1 + attempt)
        continue
      return (conv, None, None, f"exception:{exc.__class__.__name__}")
  if r is None:
    return (conv, None, None, "no_response")
  if r.status_code != 200:
    return (conv, None, None, f"error:{r.status_code}")
  results = r.json()
  results = [m for m in results if m.get("id") != conv["id"]]
  results = [m for m in results if m.get("metadata", {}).get("subcategory")]
  top = results[:5]
  if not top:
    return (conv, "General", "Other", "no_matches")
  sub_counts = Counter()
  cat_counts = Counter()
  for m in top:
    sub_counts[m["metadata"].get("subcategory", "Other")] += 1
    cat_counts[m["metadata"].get("category", "General")] += 1
  pred_sub, _ = sub_counts.most_common(1)[0]
  pred_cat, _ = cat_counts.most_common(1)[0]
  return (conv, pred_cat, pred_sub, None)


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--sample-per-sub", type=int, default=100, help="Sample per subcategory (0 = all)")
  parser.add_argument("--full", action="store_true", help="Evaluate full dataset (ignores sample-per-sub)")
  parser.add_argument("--max-workers", type=int, default=4)
  parser.add_argument("--match-threshold", type=float, default=0.5)
  parser.add_argument("--match-count", type=int, default=10)
  args = parser.parse_args()

  key = get_key()
  if not key:
    raise SystemExit("Missing SUPABASE_CLOUD_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY")

  labeled = fetch_labeled_metadata(key)
  print("labeled_total", len(labeled))

  if args.full:
    sample = labeled
  else:
    sample = sample_by_subcategory(labeled, args.sample_per_sub)

  print("sample_size", len(sample))

  # fetch embeddings only for sample ids
  id_list = [c["id"] for c in sample]
  embeddings = fetch_embeddings_for_ids(key, id_list, batch_size=200)
  for c in sample:
    c["embedding"] = embeddings.get(c["id"])

  sample = [c for c in sample if c.get("embedding")]
  print("sample_with_embeddings", len(sample))

  start = time.time()
  correct_sub = 0
  correct_cat = 0
  total = 0
  errors = 0
  conf = defaultdict(Counter)
  cat_conf = defaultdict(Counter)

  with ThreadPoolExecutor(max_workers=args.max_workers) as ex:
    futures = [ex.submit(classify, c, key, args.match_threshold, args.match_count) for c in sample]
    for i, fut in enumerate(as_completed(futures), 1):
      conv, pred_cat, pred_sub, err = fut.result()
      total += 1
      if err:
        errors += 1
        continue
      if pred_sub == conv["subcategory"]:
        correct_sub += 1
      if pred_cat == conv["category"]:
        correct_cat += 1
      conf[conv["subcategory"]][pred_sub] += 1
      cat_conf[conv["category"]][pred_cat] += 1
      if i % 200 == 0:
        print("processed", i, "errors", errors)

  elapsed = time.time() - start
  accuracy_sub = correct_sub / total if total else 0
  accuracy_cat = correct_cat / total if total else 0

  summary = {
    "sample_size": total,
    "errors": errors,
    "accuracy_sub": accuracy_sub,
    "accuracy_cat": accuracy_cat,
    "elapsed_sec": round(elapsed, 1),
  }

  with open("/tmp/hubspot_eval_summary.json", "w") as f:
    json.dump(summary, f, indent=2)
  with open("/tmp/hubspot_eval_confusion.json", "w") as f:
    json.dump({k: v.most_common(10) for k, v in conf.items()}, f, indent=2)

  print("summary", json.dumps(summary, indent=2))


if __name__ == "__main__":
  main()
