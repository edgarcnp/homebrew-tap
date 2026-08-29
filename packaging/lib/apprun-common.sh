#!/bin/bash

# Shared AppRun preamble for the per-app AppRun templates. The AppImage
# runtime may invoke AppRun through symlinks (or a host may inject a bogus
# APPDIR env var), so this resolves the real AppDir root from the AppRun
# path and exports APPDIR. Must be shipped as apprun-common.sh next to
# AppRun inside the AppDir; every AppRun template sources it first.
(return 0 2>/dev/null) || exit 1

resolve_appdir() {
  local source="${BASH_SOURCE[1]:-$0}"
  local dir
  local max_links=20

  while [[ -L "${source}" ]] && [[ "${max_links}" -gt 0 ]]
  do
    dir="$(cd -P -- "$(dirname -- "${source}")" && pwd)"
    source="$(readlink -- "${source}")"
    case "${source}" in
      /*) ;;
      *) source="${dir}/${source}" ;;
    esac
    max_links=$((max_links - 1))
  done
  if [[ "${max_links}" -eq 0 ]]
  then
    echo "Too many symlink levels" >&2
    exit 1
  fi

  # dirname(1) is an external command; substitute parameter expansion for
  # the hot path. Empty (source="/AppRun") maps to "/", no slash to ".".
  local source_dir
  if [[ "${source}" == */* ]]
  then
    source_dir="${source%/*}"
    [[ -n "${source_dir}" ]] || source_dir="/"
  else
    source_dir="."
  fi
  cd -P -- "${source_dir}" && pwd
}

resolved_appdir="$(resolve_appdir)"
if [[ -n "${APPDIR:-}" ]] && [[ "${APPDIR}" != "${resolved_appdir}" ]]
then
  appdir_canonical="$(cd -P -- "${APPDIR}" 2>/dev/null && pwd)" || appdir_canonical=""
  [[ "${appdir_canonical}" = "${resolved_appdir}" ]] || APPDIR="${resolved_appdir}"
elif [[ -z "${APPDIR:-}" ]]
then
  APPDIR="${resolved_appdir}"
fi
export APPDIR
