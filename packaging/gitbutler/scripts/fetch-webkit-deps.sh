#!/bin/bash
set -Eeuo pipefail

# Download the webkit runtime dependency closure (libwebkit2gtk-*) so the
# gitbutler AppImage is self-contained. Roots come from the .deb's Depends
# (auto-handles soname bumps); requires apt or WEBKIT_DEPS_DIR_OVERRIDE.
#
# Trust model: the apt index (including the per-package SHA-256) is fetched
# by apt over HTTPS and signature-verified against apt's own keyring, so the
# index hash is trusted; every downloaded .deb is verified against it before
# the build script may bundle it.
#
# Host apt state is untouched: lists and archives are redirected into the
# work dir via -o Dir::Etc::lists / Dir::Cache::archives.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LIB_DIR="$(cd "${PACKAGING_DIR}/../lib" && pwd)"

# shellcheck disable=SC1091 # sourced file is followed only when shellcheck runs with -x
# shellcheck source=../../lib/package-common.sh
. "${LIB_DIR}/package-common.sh"

webkit_root_packages() {
  local deb_path="$1"
  local -a dep_fields=()
  local field
  local -a roots=()

  # Depends is comma-separated with optional constraints; names never contain
  # spaces, so split each field at the first space.
  IFS=',' read -r -a dep_fields <<<"$(dpkg-deb -f "${deb_path}" Depends | tr -d '\n')"
  for field in "${dep_fields[@]}"
  do
    field="${field%% *}"
    case "${field}" in
      libwebkit2gtk-*) roots+=("${field}") ;;
      *) ;; # non-webkit Depends entries are intentionally not roots
    esac
  done
  if ((${#roots[@]} > 0))
  then
    printf '%s\n' "${roots[@]}"
  fi
}

map_arch() {
  case "${TARGET_ARCH}" in
    amd64 | x86_64)
      printf '%s %s\n' amd64 x86_64-linux-gnu
      ;;
    arm64 | aarch64)
      printf '%s %s\n' arm64 aarch64-linux-gnu
      ;;
    *) error "Unsupported architecture: ${TARGET_ARCH}" ;;
  esac
}

# Look up the SHA-256 the apt index records for the exact version of a
# downloaded .deb (primary: apt-cache show; fallback: parse the scoped lists
# dir, handling compressed index files). Returns 1 when the index has no hash.
index_sha256_for_deb() {
  local deb_path="$1"
  local pkg ver sha
  pkg="$(dpkg-deb -f "${deb_path}" Package)"
  ver="$(dpkg-deb -f "${deb_path}" Version)"

  sha="$(apt-cache show --no-all-versions "${pkg}" "${APT_OPTS[@]}" 2>/dev/null | awk -v want="${ver}" '
    $1 == "Version:" { v = $2 }
    $1 == "SHA256:" { s = $2 }
    END { if (v == want) print s }')"
  if [[ -n "${sha}" ]]
  then
    printf '%s\n' "${sha}"
    return 0
  fi

  local list_file
  local -a reader=()
  for list_file in "${APT_STATE_DIR}"/lists/*Packages*
  do
    [[ -f "${list_file}" ]] || continue
    case "${list_file}" in
      *.lz4) reader=(lz4cat "${list_file}") ;;
      *.xz) reader=(xzcat "${list_file}") ;;
      *.gz) reader=(zcat "${list_file}") ;;
      *.bz2) reader=(bzcat "${list_file}") ;;
      *) reader=(cat "${list_file}") ;;
    esac
    sha="$("${reader[@]}" 2>/dev/null | awk -v want="${pkg}" -v wver="${ver}" '
      /^Package: / { p = $2; v = ""; s = "" }
      /^Version: / { v = $2 }
      /^SHA256: / { s = $2 }
      p == want && v == wver && s != "" { print s; exit }')"
    if [[ -n "${sha}" ]]
    then
      printf '%s\n' "${sha}"
      return 0
    fi
  done
  return 1
}

main() {
  TARGET_ARCH="${1:-${TARGET_ARCH:-$(uname -m)}}"
  local deps_dir="${2:-}"
  local deb_path="${3:-}"
  if [[ -z "${deps_dir}" ]]
  then
    deps_dir="${WORK_DIR:-$(pwd)}/webkit-deps"
  fi

  local deb_arch apt_triplet
  read -r deb_arch apt_triplet < <(map_arch)

  if [[ -n "${WEBKIT_DEPS_DIR_OVERRIDE:-}" ]]
  then
    [[ -d "${WEBKIT_DEPS_DIR_OVERRIDE}" ]] || error "WEBKIT_DEPS_DIR_OVERRIDE is not a directory: ${WEBKIT_DEPS_DIR_OVERRIDE}"
    [[ -n "$(compgen -G "${WEBKIT_DEPS_DIR_OVERRIDE}"/*.deb)" ]] || error "WEBKIT_DEPS_DIR_OVERRIDE contains no .deb files: ${WEBKIT_DEPS_DIR_OVERRIDE}"
    info "Using pre-downloaded webkit dependency debs: ${WEBKIT_DEPS_DIR_OVERRIDE}"
    printf '%s\n' "${WEBKIT_DEPS_DIR_OVERRIDE}"
    return 0
  fi

  command -v apt-get >/dev/null 2>&1 || error "apt-get is unavailable.
The webkit dependency closure is resolved on an ubuntu-24.04 host (where the CI
workflow runs). Build there, or reuse a pre-downloaded set of debs by exporting
WEBKIT_DEPS_DIR_OVERRIDE=/path/to/dir-of-debs."
  command -v apt-cache >/dev/null 2>&1 || error "apt-cache is unavailable.
Install apt or set WEBKIT_DEPS_DIR_OVERRIDE to a directory of pre-downloaded debs."

  local -a apt_cmd=()
  if [[ "$(id -u)" -ne 0 ]]
  then
    command -v sudo >/dev/null 2>&1 || error "apt-get needs root but sudo is unavailable.
Run as root, or set WEBKIT_DEPS_DIR_OVERRIDE to a directory of pre-downloaded debs."
    apt_cmd=(sudo -n)
  fi

  # Redirect apt's lists and archive cache into the work dir so the host's
  # apt state (sources, lists, caches) is never mutated. All apt/apt-cache
  # invocations below must carry APT_OPTS so they read the same scoped state.
  APT_STATE_DIR="${deps_dir}/.apt-state"
  APT_OPTS=(
    -o "Dir::Etc::lists=${APT_STATE_DIR}/lists"
    -o "Dir::Cache::archives=${APT_STATE_DIR}/archives"
  )
  mkdir -p "${APT_STATE_DIR}/lists/partial" "${APT_STATE_DIR}/archives/partial"

  info "Resolving webkit runtime dependency closure for ${deb_arch} (${apt_triplet})"
  info "Updating apt package index (scoped to ${APT_STATE_DIR})"
  "${apt_cmd[@]}" apt-get update -qq "${APT_OPTS[@]}" >/dev/null

  local -a webkit_roots=()
  [[ -n "${deb_path}" ]] || error "Missing GitButler .deb path argument; pass it as the third argument."
  command -v dpkg-deb >/dev/null 2>&1 || error "dpkg-deb is unavailable (needed to read ${deb_path} Depends)."
  mapfile -t webkit_roots < <(webkit_root_packages "${deb_path}")
  [[ ${#webkit_roots[@]} -gt 0 ]] || error "No libwebkit2gtk-* dependency found in ${deb_path} Depends: \
GitButler's .deb must depend on the webkit runtime libraries."
  info "Webkit root packages (from .deb Depends): ${webkit_roots[*]}"

  mkdir -p "${deps_dir}"
  local closure_file="${deps_dir}/closure.txt"
  apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances "${APT_OPTS[@]}" "${webkit_roots[@]}" |
    awk '/^  (Depends|PreDepends): /{gsub(/[<>]/, "", $2); print $2}' >"${closure_file}"
  printf '%s\n' "${webkit_roots[@]}" >>"${closure_file}"
  sort -u "${closure_file}" -o "${closure_file}"
  sed -n -e '/-dev$/d' -e '/-dbg$/d' -e '/-doc$/d' -e '/^libc6$/d' -e '/^libc-bin$/d' -e '/^locales$/d' -e p "${closure_file}" >"${closure_file}.filtered"
  mv "${closure_file}.filtered" "${closure_file}"

  local -a packages=()
  local -a pending=()
  local p
  mapfile -t pending <"${closure_file}"
  for p in "${pending[@]}"
  do
    [[ -n "${p}" ]] || continue
    case "${p}" in
      *:*) p="${p%%:*}" ;; # strip any arch qualifier (:any, :amd64, ...)
      *) ;;                # unqualified package names pass through
    esac
    if [[ "$(apt-cache show --no-all-versions "${p}" "${APT_OPTS[@]}" 2>/dev/null | grep -c '^Version: ')" -gt 0 ]]
    then
      packages+=("${p}")
    else
      # Virtual package: resolve via its providers so apt-get download gets a real .deb.
      local -a providers=()
      mapfile -t providers < <(apt-cache showpkg "${p}" "${APT_OPTS[@]}" | sed -n '/^Reverse Provides:/,/^[^ ]/p' | sed '1d' | awk 'NF{print $1}' | sort -u)
      if [[ ${#providers[@]} -eq 0 ]]
      then
        error "No provider found for virtual package ${p} in the webkit dependency closure"
      else
        info "Resolving virtual package ${p} via: ${providers[*]}"
        packages+=("${providers[@]}")
      fi
    fi
  done
  local -a unique_packages=()
  mapfile -t unique_packages < <(printf '%s\n' "${packages[@]}" | sort -u)
  info "Downloading ${#unique_packages[@]} webkit dependency packages"
  (cd "${deps_dir}" && apt-get download "${APT_OPTS[@]}" "${unique_packages[@]}" >/dev/null)

  info "Verifying downloaded webkit dependency debs against the apt index"
  local deb sha actual
  for deb in "${deps_dir}"/*.deb
  do
    [[ -e "${deb}" ]] || continue
    sha="$(index_sha256_for_deb "${deb}")" || error "No SHA-256 in apt index for downloaded deb: $(basename "${deb}")"
    actual="$(sha256sum "${deb}" | awk '{print $1}')"
    [[ "${actual}" = "${sha}" ]] || error "SHA-256 mismatch for $(basename "${deb}"): index ${sha}, downloaded ${actual}"
  done

  info "Downloaded and verified webkit dependency closure in ${deps_dir}"
  printf '%s\n' "${deps_dir}"
}

main "$@"
