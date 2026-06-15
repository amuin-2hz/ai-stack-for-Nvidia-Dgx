#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${AI_STACK_BASE:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
CATALOG="${BASE_DIR}/configs/model_catalog.csv"
DOWNLOADER="${BASE_DIR}/ops/scripts/hf-download.sh"

if [[ ! -f "${CATALOG}" ]]; then
  echo "Catalog not found: ${CATALOG}" >&2
  exit 1
fi

if [[ ! -x "${DOWNLOADER}" ]]; then
  echo "Downloader is not executable: ${DOWNLOADER}" >&2
  exit 1
fi

tail -n +2 "${CATALOG}" | while IFS=, read -r alias requested_name repo_id status role residency notes; do
  if [[ "${status}" != "known" ]]; then
    echo "Skipping ${requested_name}: status=${status}"
    continue
  fi

  if [[ -z "${repo_id}" ]]; then
    echo "Skipping ${requested_name}: missing repo_id"
    continue
  fi

  echo "Downloading ${requested_name} from ${repo_id} into ${alias}"
  "${DOWNLOADER}" "${repo_id}" "${alias}"
done
