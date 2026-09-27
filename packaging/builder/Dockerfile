# Builder image for the AppImage pipeline: the Arch toolchain every build job
# used to install on each run, baked once. Built by .github/workflows/builder.yml
# and pinned by tag+digest in packaging/builder/pins.json.
#
# Variants (--build-arg VARIANT=):
#   base   - the shared toolchain
#   webkit - base plus the webkit2gtk/GTK closure little-genius and cline need
#
# The package list is deliberately small. This pipeline repackages released
# binaries and never compiles, so build systems (the base-devel meta: gcc,
# autoconf, automake, gettext, groff, texinfo, ...) stay out; the GUI libraries
# a payload links against come from get-debloated-pkgs at build time, as they
# always have. What is here:
#   - binutils: quick-sharun's strip pass (skipped, with a warning, when absent)
#   - file: the magic database quick-sharun can bundle
#   - nss: Electron's libnss3 must exist in the build environment for the
#     closure scan to find it
#   - the rest is download, extract, verify and packing tooling.
#
# Renovate owns the pins: the FROM digest (docker manager), the appimagetool
# version in the URL below (regex manager), the Bun ARG (regex manager), and
# packaging/scripts/install-anylinux-tools.sh (git-refs manager).
#
# Build from the repository root:
#   docker build -f packaging/builder/Dockerfile --build-arg VARIANT=base .

# The base is deliberately pkgforge's archlinux image, not the official
# archlinux one: quick-sharun and get-debloated-pkgs are developed against it,
# the per-run builds used it before this image existed, and every AppImage
# bundles its glibc and friends. Renovate owns the digest; do not swap the base
# for a "minimal" image without re-validating the pkgforge tools against it.
FROM ghcr.io/pkgforge-dev/archlinux:v2026.09.05@sha256:b2507f1964270cab3cc190aa8df858521f6a7e45e969146a012877891d5dfc9b

ARG VARIANT=base
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.2

RUN pacman-key --init \
 && pacman -Syy --noconfirm archlinux-keyring \
 && pacman -Syu --noconfirm \
      binutils \
      curl \
      dpkg \
      file \
      git \
      gnupg \
      jq \
      nss \
      patchelf \
      unzip \
      wget \
      xorg-server-xvfb \
      zsync \
 && if [ "${VARIANT}" = "webkit" ]; then \
      pacman -S --noconfirm \
        gdk-pixbuf2 \
        glib-networking \
        gtk3 \
        libayatana-appindicator \
        libxcb \
        libxcursor \
        libxi \
        libxkbcommon \
        libxkbcommon-x11 \
        libxrandr \
        libxtst \
        webkit2gtk-4.1; \
    fi \
 && pacman -Scc --noconfirm

# quick-sharun and get-debloated-pkgs, pinned to the commit the script carries.
COPY packaging/scripts/install-anylinux-tools.sh /usr/local/src/install-anylinux-tools.sh
RUN bash /usr/local/src/install-anylinux-tools.sh \
 && rm /usr/local/src/install-anylinux-tools.sh

# pkgforge appimagetool (uruntime). Renovate rewrites the version in this URL.
RUN curl -fL -o /usr/local/bin/appimagetool \
      "https://github.com/pkgforge-dev/appimagetool/releases/download/0.5.2/appimagetool-x86_64-linux" \
 && chmod 0755 /usr/local/bin/appimagetool

# Bun, the orchestrator runtime, pinned to the same version CI sets up. The
# versioned release archive is used instead of bun.sh/install, whose body
# changes in place; x64 is the builder image's platform.
RUN curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun /tmp/bun.zip \
 && /usr/local/bin/bun --version
