#!/usr/bin/env bash
# Install the Muse Code CLI from a pinned versioned artifact.
#
# No curl-pipe-bash: the exact release binary is downloaded to a file, its
# SHA256 is verified against the committed manifest checksum, and only then
# is it installed. To bump versions, query the channel API for the current
# release and manifest, e.g.:
#   curl -fsSL 'https://api.meta.ai/muse-code/channels/muse-stable'
# then update MUSE_VERSION plus both checksums below from that manifest.
#
# Env in: HOME, GITHUB_PATH. Must run on Linux (runner: ubuntu-latest).
set -euo pipefail

MUSE_VERSION="1.4.7-R6101.1"
# From manifest.json for MUSE_VERSION (retrieved 2026-10-14 over TLS):
# https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.7-R6101.1&file=manifest.json
SHA_X86_LINUX="36e3dac91f56c15572b95be55d70ee9fd9685cd9ab49f747bab4746c8d7c2518"
SHA_AARCH64_LINUX="48db3c7468cd4f401eff9b415fb7e0cdfe0351fb1730649ceae2a0f766e23b85"

arch="$(uname -m)"
case "${arch}" in
  x86_64) artifact="muse-x86-linux"; want_sha="${SHA_X86_LINUX}" ;;
  aarch64|arm64) artifact="muse-aarch64-linux"; want_sha="${SHA_AARCH64_LINUX}" ;;
  *) echo "::error::Unsupported architecture for pinned Muse install: ${arch}" >&2; exit 1 ;;
esac
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "::error::Pinned Muse install supports Linux runners only." >&2
  exit 1
fi

tmp_bin="$(mktemp)"
trap 'rm -f "${tmp_bin}"' EXIT
# --proto '=https' forbids redirect downgrades; --retry rides out flakes.
curl --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors \
  --connect-timeout 15 --max-time 600 -fsSL -o "${tmp_bin}" \
  "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${MUSE_VERSION}&file=${artifact}"

got_sha="$(sha256sum "${tmp_bin}" | awk '{print $1}')"
if [[ "${got_sha}" != "${want_sha}" ]]; then
  echo "::error::Muse binary checksum mismatch for ${MUSE_VERSION}/${artifact}; refusing to install." >&2
  exit 1
fi

install_dir="${HOME}/.local/bin"
mkdir -p "${install_dir}"
install -m 0755 "${tmp_bin}" "${install_dir}/muse"
echo "${install_dir}" >> "${GITHUB_PATH}"
"${install_dir}/muse" --version
