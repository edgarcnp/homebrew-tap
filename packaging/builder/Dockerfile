# Builder image for the AppImage pipeline: the Arch base toolchain every build
# job used to install on each run, baked once and shared by every app. Built by
# .github/workflows/builder.yml and pinned by tag+digest in
# packaging/builder/pins.json.
#
# One base image serves every app. Pack-time libraries an app needs but the
# base does not carry (little-genius's webkit2gtk/GTK closure, for example) are
# declared in the descriptor's `buildPackages` and installed by the build job
# before the pack stages, so there is no image variant to select.
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
# version in the URL below (regex manager), the Node ARG (regex manager), and
# packaging/scripts/install-anylinux-tools.sh (git-refs manager).
#
# Build from the repository root:
#   docker build -f packaging/builder/Dockerfile .

# The base is deliberately pkgforge's archlinux image, not the official
# archlinux one: quick-sharun and get-debloated-pkgs are developed against it,
# the per-run builds used it before this image existed, and every AppImage
# bundles its glibc and friends. Renovate owns the digest; do not swap the base
# for a "minimal" image without re-validating the pkgforge tools against it.
FROM ghcr.io/pkgforge-dev/archlinux:v2026.09.05@sha256:b2507f1964270cab3cc190aa8df858521f6a7e45e969146a012877891d5dfc9b

# renovate: datasource=node-version depName=node
ARG NODE_VERSION=24.17.0

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
 && pacman -Scc --noconfirm

# quick-sharun and get-debloated-pkgs, pinned to the commit the script carries.
COPY packaging/scripts/install-anylinux-tools.sh /usr/local/src/install-anylinux-tools.sh
RUN bash /usr/local/src/install-anylinux-tools.sh \
 && rm /usr/local/src/install-anylinux-tools.sh

# pkgforge appimagetool (uruntime). Renovate rewrites the version in this URL.
RUN curl -fL -o /usr/local/bin/appimagetool \
      "https://github.com/pkgforge-dev/appimagetool/releases/download/0.5.2/appimagetool-x86_64-linux" \
 && chmod 0755 /usr/local/bin/appimagetool

# Node.js, the orchestrator runtime, pinned to the same version CI sets up.
# The official static build from nodejs.org is used instead of pacman's rolling
# nodejs, and a versioned directory instead of a moving URL; x64 is the
# builder image's platform.
RUN curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.gz \
 && /usr/local/bin/node --version
