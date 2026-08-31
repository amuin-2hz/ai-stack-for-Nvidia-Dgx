#!/usr/bin/env python3
import concurrent.futures
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

API_HOST = os.environ.get("MODELSCOPE_API_HOST", "https://www.modelscope.cn").rstrip("/")
REPO_ID = os.environ["MODELSCOPE_MODEL_ID"].replace(".git", "")
REVISION = os.environ.get("MODELSCOPE_REVISION", "master")
LOCAL_DIR = Path(os.environ.get("MODELSCOPE_LOCAL_DIR", "/models"))
MAX_WORKERS = max(1, int(os.environ.get("MODELSCOPE_MAX_WORKERS", "4")))
TIMEOUT = int(os.environ.get("MODELSCOPE_DOWNLOAD_TIMEOUT", "60"))
RETRIES = max(1, int(os.environ.get("MODELSCOPE_DOWNLOAD_RETRIES", "5")))
TOKEN = os.environ.get("MODELSCOPE_TOKEN") or os.environ.get("MODELSCOPE_API_TOKEN")

session = requests.Session()
if TOKEN:
    session.headers.update({"Authorization": "Bearer " + TOKEN})


def api_url(path):
    return API_HOST + "/api/v1/models/" + quote(REPO_ID, safe="/") + path


def file_list():
    url = api_url("/repo/files")
    response = session.get(url, params={"Revision": REVISION, "Recursive": "true"}, timeout=TIMEOUT)
    response.raise_for_status()
    payload = response.json()
    files = payload.get("Data", {}).get("Files", [])
    result = []
    for item in files:
        path = item.get("Path")
        if not path or item.get("Type") == "tree":
            continue
        if path == ".gitattributes" or path.startswith(".git/") or "/.git/" in path:
            continue
        result.append({"path": path, "size": int(item.get("Size") or 0)})
    return result


def human_bytes(value):
    value = float(max(0, value))
    for unit in ("B", "kB", "MB", "GB", "TB"):
        if value < 1000 or unit == "TB":
            if unit == "B":
                return str(int(value)) + unit
            return ("%.2f" % value).rstrip("0").rstrip(".") + unit
        value /= 1000


def human_duration(seconds):
    seconds = int(max(0, seconds))
    hours, rem = divmod(seconds, 3600)
    minutes, sec = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes:02d}:{sec:02d}"


def destination_for(path):
    destination = (LOCAL_DIR / path).resolve()
    root = LOCAL_DIR.resolve()
    if destination != root and not str(destination).startswith(str(root) + os.sep):
        raise RuntimeError("Refusing unsafe path from ModelScope manifest: " + path)
    return destination


def download_url(path):
    return api_url("/repo") + "?Revision=" + quote(REVISION, safe="") + "&FilePath=" + quote(path, safe="")


def download_one(item):
    path = item["path"]
    total = int(item.get("size") or 0)
    destination = destination_for(path)
    part = destination.with_name(destination.name + ".part")
    destination.parent.mkdir(parents=True, exist_ok=True)

    if destination.exists() and total and destination.stat().st_size == total:
        return path, total

    for attempt in range(1, RETRIES + 1):
        resume_at = part.stat().st_size if part.exists() else 0
        headers = {}
        mode = "wb"
        if resume_at > 0:
            headers["Range"] = f"bytes={resume_at}-"
            mode = "ab"
        started = time.monotonic()
        last_report = 0.0
        downloaded = resume_at
        try:
            with session.get(download_url(path), headers=headers, stream=True, timeout=TIMEOUT) as response:
                if response.status_code == 416 and destination.exists():
                    return path, destination.stat().st_size
                if response.status_code == 200 and resume_at > 0:
                    resume_at = 0
                    downloaded = 0
                    mode = "wb"
                response.raise_for_status()
                with part.open(mode + ("" if "b" in mode else "b")) as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        downloaded += len(chunk)
                        now = time.monotonic()
                        if now - last_report >= 1:
                            elapsed = max(0.001, now - started)
                            speed = max(0.0, (downloaded - resume_at) / elapsed)
                            remaining = total - downloaded if total else 0
                            eta = human_duration(remaining / speed) if total and speed > 0 else "?"
                            print(
                                f"Downloading [{path}]: {human_bytes(downloaded)}/{human_bytes(total)} "
                                f"[{human_duration(elapsed)}<{eta}, {human_bytes(speed)}/s]",
                                flush=True,
                            )
                            last_report = now
            if total and part.stat().st_size != total:
                raise RuntimeError(f"size mismatch for {path}: got {part.stat().st_size}, expected {total}")
            os.replace(part, destination)
            return path, destination.stat().st_size
        except Exception as exc:
            if attempt == RETRIES:
                raise
            print(f"Download [{path}] failed on attempt {attempt}/{RETRIES}: {exc}; retrying", file=sys.stderr, flush=True)
            time.sleep(min(60, 2 * attempt))
    return path, destination.stat().st_size if destination.exists() else 0


def main():
    files = file_list()
    total = len(files)
    print(f"Processing {total} items: 0%| | 0/{total} [00:00<?, ?it/s]", flush=True)
    started = time.monotonic()
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(download_one, item): item for item in files}
        for future in concurrent.futures.as_completed(futures):
            path, size = future.result()
            done += 1
            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed > 0 else 0
            remaining = (total - done) / rate if rate > 0 else 0
            percent = int((done / total) * 100) if total else 100
            print(
                f"Downloaded [{path}]: {human_bytes(size)}",
                flush=True,
            )
            print(
                f"Processing {total} items: {percent}%| | {done}/{total} "
                f"[{human_duration(elapsed)}<{human_duration(remaining)}, {rate:.2f}it/s]",
                flush=True,
            )


if __name__ == "__main__":
    main()
