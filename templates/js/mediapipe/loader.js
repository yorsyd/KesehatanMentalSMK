/**
 * loader.js — memuat MediaPipe tasks-vision dari file LOKAL (tanpa CDN).
 * Dieksekusi sebagai script klasik; dynamic-import() modul ES lalu
 * mengekspos FilesetResolver & FaceLandmarker ke window.
 */
(function () {
  "use strict";
  window.__mediapipeReady = false;

  import("/templates/js/mediapipe/vision_bundle.module.js")
    .then(function (mod) {
      window.FilesetResolver = mod.FilesetResolver;
      window.FaceLandmarker = mod.FaceLandmarker;
      window.__mediapipeReady = true;
      window.dispatchEvent(new Event("mediapipe-ready"));
      console.info("[MediaPipe] Pustaka lokal siap.");
    })
    .catch(function (e) {
      console.error("[MediaPipe] Gagal memuat pustaka lokal:", e);
    });
})();