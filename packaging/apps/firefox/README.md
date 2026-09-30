# firefox

Descriptor: [`app.json`](app.json). Shared stages and the field reference are in
the [pipeline README](../../README.md).

Built from the signed `.deb` Mozilla publishes on
`https://packages.mozilla.org/apt` (suite `mozilla`).

## Trust model

GPG chain: the repository key is pinned in [`assets/`](assets) by fingerprint,
`InRelease` is verified against it, and both the `Packages` index and the
downloaded `.deb` are checked against the SHA-256 and size the signed index
records. The repository host is pinned too — the downloader accepts no edge
host.

## App-specific

- **Version source** — `apt`: the index's versions carry Mozilla's rebuild
  marker (`157.0~build1`), which `normalizeUpstreamVersion` strips, so the cask
  version is `157.0`. The release feed
  (`product-details.mozilla.org/1.0/firefox_versions.json`,
  `LATEST_FIREFOX_VERSION`) announces the same string, so the watcher never sees
  a rebuild marker as "newer" than the pin.
- **Payload** — `deb-tree`: the whole `usr/lib/firefox` tree is staged into
  `AppDir/bin`, unchanged. Firefox's own libraries (including `libxul.so`)
  carry no `$ORIGIN` rpath and are loaded next to the binary through
  `dependentlibs.list`, so the pack stage puts `AppDir/bin` on `LD_LIBRARY_PATH`
  for quick-sharun's closure scan (see the pipeline README).
- **Codecs** — Firefox ships its own decoders in `libmozavcodec.so` and
  `libgkcodecs.so` (H.264, HEVC, VP9, AV1, MP3, FLAC, Opus, Vorbis, …). The
  codecs it does not ship (AAC, AC-3/E-AC-3, MPEG-4, VC-1, TrueHD, …) come from
  the system FFmpeg this AppImage bundles: `ffmpeg-mini` via
  `get-debloated-pkgs`, with `/usr/lib/libavcodec.so.63` declared as a
  quick-sharun deploy target. `libavcodec`'s soname is what Firefox probes
  (`libavcodec.so.53`–`.63` in the 157 build), and it is the one pinned path
  here to bump when Arch's FFmpeg major changes.
  - OpenH264 and Widevine are not bundled: Mozilla does not redistribute the
    Cisco binary (patent coverage is download-only), and Widevine is
    proprietary. Both keep working the way upstream intends — the OpenH264
    plugin is fetched on demand, and Widevine can be installed into the
    profile.
- **Dlopened libraries** — everything Firefox only `dlopen`s at runtime is an
  explicit `quickSharun.libraries` entry, since `ldd` cannot see it: PipeWire
  (camera/WebRTC), libva/libva-drm (hardware decode; the OpenGL deployment
  already brings the `libva-*` family), CUPS printing, libsecret (keyring),
  GSSAPI/Kerberos, libudev (gamepads), libXss (screen-blanking inhibit),
  libcanberra (event sounds) and libspeechd (speech synthesis). PulseAudio is
  deployed automatically by quick-sharun (the `libpulse.so` string is present
  in libxul). `DEPLOY_OPENGL`/`DEPLOY_VULKAN` cover the GPU stacks, and
  `intel-media-driver-mini` supplies the Intel VA-API driver.
- **Locales** — the deb carries en-US only. Other languages are separate
  `firefox-l10n-*` packages that the one-deb pipeline does not stage; a language
  can still be added at runtime from addons.mozilla.org.
- **Updater** — the update service endpoint (`https://aus5.mozilla.org`) lives
  in `application.ini`, `firefox-bin` and `libxul.so`, which are patched
  same-length, and in `omni.ja`, which is a CRC-checked archive and cannot be
  byte-patched, so the residual scan records that inert copy at
  `severity: warning`. The AppDir `.env` also pins `MOZ_LEGACY_PROFILES=1`
  (opt out of dedicated profiles, so the AppImage's per-run mount path does not
  key a new profile store on every launch) and `MOZ_APP_LAUNCHER=${APPIMAGE}`
  (relaunches go through the AppImage rather than a path inside the mount).

## Local run

`PACKAGE_VERSION` is optional; set, it must match the resolved version
(CI always sets it).

```sh
TARGET_ARCH=amd64 ./build.sh
```
