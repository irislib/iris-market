#!/usr/bin/env python3
"""Gate a running native Market process using cumulative CPU time, not ps %CPU.

Run after loading a representative feed, with AI search stopped and the window
visible. One fully occupied core is 100%. This does not count Apple's separate
model service; it measures the app's own polling/rendering/network overhead.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time


def cpu_seconds(value):
    days, _, clock = value.strip().rpartition("-")
    parts = [float(part) for part in clock.split(":")]
    if len(parts) not in (2, 3) or any(part < 0 for part in parts):
        raise ValueError("Invalid process CPU time")
    return (int(days) * 86400 if days else 0) + sum(part * 60 ** index for index, part in enumerate(reversed(parts)))


def cpu_percent(start, end, elapsed):
    if elapsed <= 0 or end < start:
        raise ValueError("Invalid CPU measurement window")
    return 100 * (end - start) / elapsed


def process(pid):
    def field(name):
        value = subprocess.check_output(["/bin/ps", "-p", str(pid), "-o", name + "="], text=True).strip()
        if not value:
            raise RuntimeError("Market process ended during measurement")
        return value
    return {"started": field("lstart"), "executable": field("comm"), "cpu": cpu_seconds(field("time")), "rss_kib": int(field("rss"))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--duration", type=float, default=30)
    parser.add_argument("--warmup", type=float, default=10)
    parser.add_argument("--max-cpu", type=float, default=10)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.pid <= 0 or args.duration < 10 or args.warmup < 0 or not 0 < args.max_cpu <= 100:
        parser.error("Use a positive PID, at least 10 seconds, and a CPU limit in (0, 100].")
    if args.output.exists():
        parser.error("Evidence already exists; select a new output path.")
    identity = process(args.pid)
    binary = Path(identity["executable"])
    if binary.name != "IrisMarket" or ".app/Contents/MacOS/" not in str(binary):
        parser.error("PID must be the native IrisMarket app.")
    def digest(path):
        hasher = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    executable_digest = digest(binary)
    # Xcode debug apps put the actual Swift/Rust image in a companion dylib.
    debug_image = binary.with_name(binary.name + ".debug.dylib")
    runtime_digest = digest(debug_image) if debug_image.is_file() else executable_digest
    time.sleep(args.warmup)
    first = process(args.pid)
    started = time.monotonic()
    peak_rss = first["rss_kib"]
    while True:
        time.sleep(min(1, max(0, args.duration - (time.monotonic() - started))))
        last = process(args.pid)
        elapsed = time.monotonic() - started
        if last["started"] != identity["started"] or last["executable"] != identity["executable"]:
            raise RuntimeError("Process changed during measurement")
        peak_rss = max(peak_rss, last["rss_kib"])
        if elapsed >= args.duration:
            break
    usage = cpu_percent(first["cpu"], last["cpu"], elapsed)
    result = {"schema": 1, "passed": usage <= args.max_cpu, "cpu_percent_one_core": round(usage, 3),
              "limit_percent": args.max_cpu, "duration_seconds": round(elapsed, 3),
              "cpu_seconds": round(last["cpu"] - first["cpu"], 3), "peak_rss_mib": round(peak_rss / 1024, 2),
              "binary_sha256": executable_digest, "runtime_image_sha256": runtime_digest}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
