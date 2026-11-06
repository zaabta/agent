"""Offline-friendly Ollama tool-call benchmark. Python 3.10+, no dependencies."""
import argparse
import csv
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

TOOLS = [
    {"type": "function", "function": {"name": "lookup_violation", "description": "Look up a violation form by its numeric form number.", "parameters": {"type": "object", "properties": {"form_no": {"type": "integer", "description": "Exact form number"}}, "required": ["form_no"]}}},
    {"type": "function", "function": {"name": "search_documents", "description": "Search indexed documents by a text query; use when an exact form number is not supplied.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "get_job_status", "description": "Check document ingestion job status by job ID.", "parameters": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"]}}},
]
CASES = [
    {"id": "form_en", "prompt": "Find violation form 65.", "expected": ("lookup_violation", {"form_no": 65})},
    {"id": "form_ar", "prompt": "ابحث عن نموذج المخالفة رقم 2728.", "expected": ("lookup_violation", {"form_no": 2728})},
    {"id": "form_tr", "prompt": "65 numaralı ihlal formunu getir.", "expected": ("lookup_violation", {"form_no": 65})},
    {"id": "job", "prompt": "Check the status of ingestion job job-test-42.", "expected": ("get_job_status", {"job_id": "job-test-42"})},
    {"id": "search", "prompt": "Search documents for personal protective equipment violations (KKD).", "expected": ("search_documents", {"query_contains": "KKD"})},
    {"id": "no_tool", "prompt": "Say hello in English. Do not look up any documents.", "expected": (None, {})},
]
SYS = "You are a document agent. Use the provided function tools whenever needed. Never invent tool results. For simple greetings, respond without tools. Only request tools; do not pretend to execute them."

def request(payload, timeout):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=data, headers={"Content-Type": "application/json"})
    start = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ans = json.load(r)
    return ans, time.perf_counter() - start

def assess(response, expected):
    calls = response.get("message", {}).get("tool_calls") or []
    name, args = expected
    if name is None:
        return not calls, "no_tool" if not calls else "unexpected_tool"
    if len(calls) != 1:
        return False, f"expected_one_call_got_{len(calls)}"
    func = calls[0].get("function", {})
    if func.get("name") != name:
        return False, "wrong_tool"
    got = func.get("arguments", {})
    if isinstance(got, str):
        try: got = json.loads(got)
        except json.JSONDecodeError: return False, "invalid_json_args"
    if not isinstance(got, dict): return False, "args_not_object"
    for k, v in args.items():
        if k == "query_contains":
            if v.casefold() not in str(got.get("query", "")).casefold():
                return False, "query_missing_keyword"
        elif got.get(k) != v:
            return False, f"wrong_{k}"
    return True, "correct"

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--models", nargs="+", default= [
    "granite4.1:3b-q4_K_M",
    "qwen3:4b-instruct-2507-q4_K_M",
    "qwen3.5:4b-q4_K_M",
    "qwen2.5:3b",
    "qwen3:4b",
    "qwen3:8b",
])
    p.add_argument("--repeat", type=int, default=3)
    p.add_argument("--ctx", type=int, default=4096)
    p.add_argument("--threads", type=int, default=6)
    p.add_argument("--timeout", type=int, default=240)
    p.add_argument("--output", default="agent_benchmark.csv")
    a = p.parse_args()
    if a.repeat < 1: p.error("--repeat must be >= 1")
    rows = []
    for model in a.models:
        print(f"\nMODEL {model}: warming up...", flush=True)
        opts = {"num_ctx": a.ctx, "num_thread": a.threads, "temperature": 0.1, "num_predict": 256, "seed": 42}
        try:
            request({"model": model, "messages": [{"role": "user", "content": "Hi"}], "stream": False, "think": False, "options": opts, "keep_alive": "10m"}, a.timeout)
        except Exception as e:
            print(f"WARNING: warmup failed: {e}")
        for rep in range(1, a.repeat + 1):
            for case in CASES:
                payload = {"model": model, "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": case["prompt"]}], "tools": TOOLS, "stream": False, "think": False, "options": opts, "keep_alive": "10m"}
                row = {"model": model, "repeat": rep, "case": case["id"], "ctx": a.ctx, "threads": a.threads}
                try:
                    response, wall = request(payload, a.timeout)
                    correct, reason = assess(response, case["expected"])
                    eval_tokens = response.get("eval_count", 0)
                    eval_s = response.get("eval_duration", 0) / 1e9
                    row.update(correct=int(correct), reason=reason, wall_s=round(wall, 3), total_s=round(response.get("total_duration", 0)/1e9,3), load_s=round(response.get("load_duration", 0)/1e9,3), prompt_tokens=response.get("prompt_eval_count", 0), output_tokens=eval_tokens, decode_tok_s=round(eval_tokens/eval_s,2) if eval_s else 0, raw_calls=json.dumps(response.get("message",{}).get("tool_calls", []), ensure_ascii=False))
                except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
                    row.update(correct=0, reason=f"ERROR: {e}", wall_s="", total_s="", load_s="", prompt_tokens="", output_tokens="", decode_tok_s="", raw_calls="")
                rows.append(row)
                print(f"{model} run={rep} {case['id']}: {row['reason']} | {row['wall_s']}s | {row['decode_tok_s']} tok/s", flush=True)
    fields = ["model", "repeat", "case", "ctx", "threads", "correct", "reason", "wall_s", "total_s", "load_s", "prompt_tokens", "output_tokens", "decode_tok_s", "raw_calls"]
    with Path(a.output).open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
    print("\nSUMMARY (warm runs, all cases):")
    for model in a.models:
        subset = [r for r in rows if r["model"] == model]
        lat = [float(r["wall_s"]) for r in subset if isinstance(r["wall_s"], (float, int))]
        rates = [float(r["decode_tok_s"]) for r in subset if isinstance(r["decode_tok_s"], (int, float)) and r["decode_tok_s"] > 0]
        print(f"{model}: accuracy={sum(r['correct'] for r in subset)}/{len(subset)} ({100*sum(r['correct'] for r in subset)/len(subset):.1f}%), median_latency={statistics.median(lat) if lat else 'N/A'}s, median_decode={statistics.median(rates) if rates else 'N/A'}tok/s")
    print(f"Saved: {Path(a.output).resolve()}")

if __name__ == "__main__": main()
