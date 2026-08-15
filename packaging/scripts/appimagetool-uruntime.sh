#!/bin/bash
# Compatibility shim: translates the upstream appimagetool CLI to the
# pkgforge uruntime fork's (-o/-n, no --no-appstream) and restores the
# output name, keeping downstream contracts unchanged. Needs PF_APPIMAGETOOL.
set -euo pipefail

PF_APPIMAGETOOL="${PF_APPIMAGETOOL:-/opt/appimagetool-uruntime}"
if [[ ! -x "${PF_APPIMAGETOOL}" ]]
then
  echo "PF_APPIMAGETOOL is not executable: ${PF_APPIMAGETOOL}" >&2
  exit 1
fi

positional=()
while [[ "$#" -gt 0 ]]
do
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
if [[ -z "${appdir}" ]]
then
  echo "missing APPDIR argument" >&2
  exit 1
fi

if [[ "${#positional[@]}" -ge 2 ]]
then
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
if [[ -n "${outname}" ]]
then
  set -- "$@" -n "${outname}"
fi
set -- "$@" "${appdir}"

echo "appimagetool-uruntime shim: exec $*" >&2
"$@"

if [[ -n "${outname}" ]] && [[ -n "${output_file}" ]]
then
  built="${outdir}/${outname}"
  if [[ -f "${built}" ]] && [[ "${built}" != "${output_file}" ]]
  then
    echo "appimagetool-uruntime shim: renaming ${built} -> ${output_file}" >&2
    mv "${built}" "${output_file}"
  fi
fi
