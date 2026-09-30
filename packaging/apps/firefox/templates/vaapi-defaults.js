// Defaults shipped by the AppImage; users can still override them in
// about:config. Firefox 137+ does not probe VA-API unless the force-enabled
// pref is set, so hardware decoding stays off without these.
pref("media.ffmpeg.vaapi.enabled", true);
pref("media.hardware-video-decoding.force-enabled", true);
pref("media.rdd-ffmpeg.enabled", true);
