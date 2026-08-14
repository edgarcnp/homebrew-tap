#!/bin/bash
# Compatibility shim for the pkgforge uruntime appimagetool.
#
# Build scripts in this tap call appimagetool with the upstream CLI:
#   appimagetool --no-appstream <APPDIR> <OUTPUT.AppImage>
# The pkgforge fork (https://github.com/pkgforge-dev/appimagetool) embeds the
# uruntime (FUSE3-native runtime mounting a dwarfs filesystem) instead of the
# type2-runtime, but uses a different CLI (-o <OUTDIR> -n <OUTNAME>, no
# --no-appstream) and writes the output without the .AppImage suffix. This
# shim translates the upstream CLI to the pkgforge one and renames the output
# to the requested name, so downstream contracts (chmod target, artifact
# upload glob, release assets, cask URL) stay unchanged.
#
# Requires PF_APPIMAGETOOL (default /opt/appimagetool-uruntime) to point at
# the pkgforge appimagetool binary for the target architecture.
set -euo pipefail

PF_APPIMAGETOOL="${PF_APPIMAGETOOL:-/opt/appimagetool-uruntime}"
if [ ! -x "${PF_APPIMAGETOOL}" ]; then
  echo "PF_APPIMAGETOOL is not executable: ${PF_APPIMAGETOOL}" >&2
  exit 1
fi

positional=()
while [ "$#" -gt 0 ]; do
  case "$1" in
  --no-appstream)
    shift
    ;;
  --)
    shift
    positional+=("$@")
    break
    ;;
  -*)
    echo "unhandled flag: $1" >&2
    exit 1
    ;;
  *)
    positional+=("$1")
    shift
    ;;
  esac
done

appdir="${positional[0]:-}"
if [ -z "${appdir}" ]; then
  echo "missing APPDIR argument" >&2
  exit 1
fi

if [ "${#positional[@]}" -ge 2 ]; then
  output_file="${positional[1]}"
  outdir="$(dirname "${output_file}")"
  outname="$(basename "${output_file}" .AppImage)"
else
  output_file=""
  outdir="."
  outname=""
fi

mkdir -p "${outdir}"

set -- "${PF_APPIMAGETOOL}" -o "${outdir}"
if [ -n "${outname}" ]; then
  set -- "$@" -n "${outname}"
fi
set -- "$@" "${appdir}"

echo "appimagetool-uruntime shim: exec $*" >&2
"$@"
rc=$?
if [ "${rc}" -ne 0 ]; then
  exit "${rc}"
fi

if [ -n "${outname}" ] && [ -n "${output_file}" ]; then
  built="${outdir}/${outname}"
  if [ -f "${built}" ] && [ "${built}" != "${output_file}" ]; then
    echo "appimagetool-uruntime shim: renaming ${built} -> ${output_file}" >&2
    mv "${built}" "${output_file}"
  fi
fi
