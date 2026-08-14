/**
 * EyeViz — Visualisasi & codec data eye tracking (vanilla JS)
 *
 * Dua tanggung jawab:
 *  1. Codec lossless-kompak: mengepak seluruh riwayat gaze (gaze_x, gaze_y,
 *     focus_score + flag fixasi/saccade) menjadi format biner kecil
 *     (Float32Array + bitmask) lalu di-base64. Tanpa downsampling —
 *     semua frame tersimpan penuh, ukuran DB tetap kecil.
 *  2. Renderer canvas: heatmap gaze + urutan fiksasi & sakad (scanpath).
 */
(function (global) {
  "use strict";

  const EyeViz = {};

  // ──────────────────────────────────────────────
  //  Codec — pack / unpack
  // ──────────────────────────────────────────────

  // Float32Array / Uint8Array -> base64 string
  function typedToBase64(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // base64 string -> Uint8Array
  function base64ToBytes(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /**
   * Pack full history -> compact payload.
   * history: [{ gaze_x, gaze_y, focus_score, is_fixating, is_saccade, ... }]
   * floats: interleaved Float32 [x0,y0,score0, x1,y1,score1, ...]
   * flags:  2 bit/frame  (bit0 = is_fixating, bit1 = is_saccade)
   */
  EyeViz.pack = function (history) {
    const n = history.length;
    const floats = new Float32Array(n * 3);
    const flags = new Uint8Array(Math.ceil(n / 4)); // 4 frame per byte

    for (let i = 0; i < n; i++) {
      const h = history[i] || {};
      floats[i * 3] = Number(h.gaze_x) || 0;
      floats[i * 3 + 1] = Number(h.gaze_y) || 0;
      floats[i * 3 + 2] = Number(h.focus_score) || 0;

      let bits = 0;
      if (h.is_fixating) bits |= 1;
      if (h.is_saccade) bits |= 2;
      const byteIdx = i >> 2;
      const shift = (i & 3) * 2;
      flags[byteIdx] |= bits << shift;
    }

    return {
      v: 1,
      n: n,
      f: typedToBase64(floats),
      g: typedToBase64(flags),
    };
  };

  /**
   * Unpack compact payload -> array of { gaze_x, gaze_y, focus_score,
   * is_fixating, is_saccade } (identik dengan data asli).
   */
  EyeViz.unpack = function (payload) {
    if (!payload || !payload.f || !payload.g) return [];
    const n = payload.n || 0;
    const floats = new Float32Array(
      base64ToBytes(payload.f).buffer,
      0,
      n * 3
    );
    const flags = base64ToBytes(payload.g);

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const bits = (flags[i >> 2] >> ((i & 3) * 2)) & 3;
      out[i] = {
        gaze_x: floats[i * 3],
        gaze_y: floats[i * 3 + 1],
        focus_score: floats[i * 3 + 2],
        is_fixating: (bits & 1) === 1,
        is_saccade: (bits & 2) === 2,
      };
    }
    return out;
  };

  // ──────────────────────────────────────────────
  //  Helpers rendering
  // ──────────────────────────────────────────────

  const GAZE_RANGE = 0.5; // normalized gaze berkisar sekitar [-0.5, 0.5]

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function setupCanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  // Map normalized gaze -> pixel
  function gazeToPx(x, y, w, h, pad) {
    const px =
      pad.left + ((x + GAZE_RANGE) / (2 * GAZE_RANGE)) * (w - pad.left - pad.right);
    const py =
      pad.top + ((y + GAZE_RANGE) / (2 * GAZE_RANGE)) * (h - pad.top - pad.bottom);
    return { x: px, y: py };
  }

  function drawGrid(ctx, w, h, pad) {
    ctx.strokeStyle = "rgba(0,0,0,0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const x = pad.left + ((w - pad.left - pad.right) / 5) * i;
      const y = pad.top + ((h - pad.top - pad.bottom) / 5) * i;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }
    // border
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.strokeRect(pad.left, pad.top, w - pad.left - pad.right, h - pad.top - pad.bottom);
  }

  function drawAxisLabels(ctx, w, h, pad) {
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("Kiri", pad.left - 6, pad.top + 4);
    ctx.textAlign = "center";
    ctx.fillText("Kanan", w - pad.right + 8, pad.top + 4);
    ctx.textAlign = "left";
    ctx.fillText("Atas", pad.left, pad.top + 4);
    ctx.textAlign = "left";
    ctx.fillText("Bawah", pad.left, h - pad.bottom + 4);
  }

  // ──────────────────────────────────────────────
  //  Heatmap
  // ──────────────────────────────────────────────

  /**
   * renderHeatmap(canvas, history, opts)
   * Bin gaze ke grid 32x32 lalu gambar density dengan radial gradient.
   */
  EyeViz.renderHeatmap = function (canvas, history, opts) {
    opts = opts || {};
    const rect = canvas.parentElement
      ? canvas.parentElement.getBoundingClientRect()
      : { width: canvas.clientWidth || 320, height: canvas.clientHeight || 240 };
    const w = opts.width || rect.width;
    const h = opts.height || rect.height;
    const pad = { top: 24, bottom: 24, left: 30, right: 30 };

    const ctx = setupCanvas(canvas, w, h);
    const data = history && history.length ? history : [];
    if (data.length < 2) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Belum ada data gaze.", w / 2, h / 2);
      return;
    }

    drawGrid(ctx, w, h, pad);
    drawAxisLabels(ctx, w, h, pad);

    // Binning
    const BINS = 32;
    const grid = new Float32Array(BINS * BINS);
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      const x = clamp(Number(data[i].gaze_x) || 0, -GAZE_RANGE, GAZE_RANGE);
      const y = clamp(Number(data[i].gaze_y) || 0, -GAZE_RANGE, GAZE_RANGE);
      const bx = Math.min(
        BINS - 1,
        Math.max(0, Math.floor(((x + GAZE_RANGE) / (2 * GAZE_RANGE)) * BINS))
      );
      const by = Math.min(
        BINS - 1,
        Math.max(0, Math.floor(((y + GAZE_RANGE) / (2 * GAZE_RANGE)) * BINS))
      );
      const idx = by * BINS + bx;
      grid[idx]++;
      if (grid[idx] > max) max = grid[idx];
    }
    if (max === 0) max = 1;

    // Warna: biru -> hijau -> merah (intensity)
    function heatColor(t) {
      const hue = 240 - t * 240; // 240 (biru) -> 0 (merah)
      return `hsla(${hue}, 85%, 55%, 1)`;
    }

    const cellW = (w - pad.left - pad.right) / BINS;
    const cellH = (h - pad.top - pad.bottom) / BINS;
    const maxRadius = Math.max(6, Math.min(cellW, cellH) * 0.9);

    ctx.globalCompositeOperation = "lighter";
    for (let by = 0; by < BINS; by++) {
      for (let bx = 0; bx < BINS; bx++) {
        const count = grid[by * BINS + bx];
        if (count <= 0) continue;
        const t = count / max;
        const cx = pad.left + (bx + 0.5) * cellW;
        const cy = pad.top + (by + 0.5) * cellH;
        const r = maxRadius * (0.35 + 0.65 * t);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, heatColor(t));
        grad.addColorStop(0.6, heatColor(t).replace(", 1)", ", 0.5)"));
        grad.addColorStop(1, heatColor(t).replace(", 1)", ", 0)"));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";

    // Legend
    const legendY = h - 8;
    const legendW = w - pad.left - pad.right;
    const lg = ctx.createLinearGradient(pad.left, 0, pad.left + legendW, 0);
    lg.addColorStop(0, heatColor(1));
    lg.addColorStop(0.5, heatColor(0.5));
    lg.addColorStop(1, heatColor(0));
    ctx.fillStyle = lg;
    ctx.fillRect(pad.left, legendY - 6, legendW, 6);
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px 'IBM Plex Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("jarang", pad.left, legendY + 4);
    ctx.textAlign = "right";
    ctx.fillText("sering", pad.left + legendW, legendY + 4);
  };

  // ──────────────────────────────────────────────
  //  Fixation + saccade sequence (scanpath)
  // ──────────────────────────────────────────────

  /**
   * renderScanpath(canvas, history, opts)
   * Gabungkan frame is_fixating berurutan menjadi fiksasi (lingkaran,
   * ukuran proporsional durasi), hubungkan dengan garis sakad bernomor.
   */
  EyeViz.renderScanpath = function (canvas, history, opts) {
    opts = opts || {};
    const rect = canvas.parentElement
      ? canvas.parentElement.getBoundingClientRect()
      : { width: canvas.clientWidth || 320, height: canvas.clientHeight || 240 };
    const w = opts.width || rect.width;
    const h = opts.height || rect.height;
    const pad = { top: 24, bottom: 24, left: 30, right: 30 };

    const ctx = setupCanvas(canvas, w, h);
    const data = history && history.length ? history : [];
    if (data.length < 3) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Belum cukup data untuk scanpath.", w / 2, h / 2);
      return;
    }

    drawGrid(ctx, w, h, pad);
    drawAxisLabels(ctx, w, h, pad);

    // ── Deteksi fiksasi (grouping consecutive is_fixating) ──
    const fixations = [];
    let cur = null;
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const isFix = !!d.is_fixating && !d.is_saccade;
      if (isFix) {
        if (!cur) cur = { sumX: 0, sumY: 0, count: 0, start: i };
        cur.sumX += Number(d.gaze_x) || 0;
        cur.sumY += Number(d.gaze_y) || 0;
        cur.count++;
      } else if (cur) {
        if (cur.count >= 3) {
          fixations.push({
            x: cur.sumX / cur.count,
            y: cur.sumY / cur.count,
            dur: cur.count,
            start: cur.start,
          });
        }
        cur = null;
      }
    }
    if (cur && cur.count >= 3) {
      fixations.push({
        x: cur.sumX / cur.count,
        y: cur.sumY / cur.count,
        dur: cur.count,
        start: cur.start,
      });
    }

    // ── Fase 1: garis sakad antar fiksasi (paling bawah) ──
    if (fixations.length >= 2) {
      ctx.lineWidth = 1.6;
      for (let i = 1; i < fixations.length; i++) {
        const a = gazeToPx(fixations[i - 1].x, fixations[i - 1].y, w, h, pad);
        const b = gazeToPx(fixations[i].x, fixations[i].y, w, h, pad);
        ctx.strokeStyle = "rgba(139, 92, 246, 0.55)";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // panah
        drawArrow(ctx, a.x, a.y, b.x, b.y);
      }
    }

    // ── Fase 2: lingkaran fiksasi ──
    if (fixations.length === 0) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Tidak ada fiksasi terdeteksi.", w / 2, h / 2);
      return;
    }

    const maxDur = Math.max.apply(
      null,
      fixations.map((f) => f.dur)
    );
    const minR = 6;
    const maxR = 22;

    fixations.forEach((fix, idx) => {
      const p = gazeToPx(fix.x, fix.y, w, h, pad);
      const r = minR + (fix.dur / maxDur) * (maxR - minR);
      // glow
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(99, 102, 241, 0.18)";
      ctx.fill();
      // body
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(79, 70, 229, 0.85)";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // nomor urut
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px 'Space Grotesk', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(idx + 1), p.x, p.y);
      ctx.textBaseline = "alphabetic";
    });

    // Legend
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px 'IBM Plex Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("fiksasi: ukuran = durasi", pad.left, h - 6);
  };

  function drawArrow(ctx, x1, y1, x2, y2) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = 8;
    const head = 0.5;
    ctx.strokeStyle = "rgba(139, 92, 246, 0.85)";
    ctx.fillStyle = "rgba(139, 92, 246, 0.85)";
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - len * Math.cos(ang - head),
      y2 - len * Math.sin(ang - head)
    );
    ctx.lineTo(
      x2 - len * Math.cos(ang + head),
      y2 - len * Math.sin(ang + head)
    );
    ctx.closePath();
    ctx.fill();
  }

  // ──────────────────────────────────────────────
  //  Focus score line chart (ringkas)
  // ──────────────────────────────────────────────

  EyeViz.renderFocusChart = function (canvas, history, opts) {
    opts = opts || {};
    const rect = canvas.parentElement
      ? canvas.parentElement.getBoundingClientRect()
      : { width: canvas.clientWidth || 320, height: canvas.clientHeight || 120 };
    const w = opts.width || rect.width;
    const h = opts.height || rect.height;
    const pad = { top: 8, bottom: 16, left: 8, right: 8 };

    const ctx = setupCanvas(canvas, w, h);
    const data = history && history.length ? history : [];
    if (data.length < 2) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "11px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("—", w / 2, h / 2);
      return;
    }

    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    const stepX = plotW / (data.length - 1);
    const toY = (s) => pad.top + plotH - (clamp(s, 0, 100) / 100) * plotH;

    // grid
    ctx.strokeStyle = "rgba(0,0,0,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    // area
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + plotH);
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + i * stepX;
      const y = toY(Number(data[i].focus_score) || 0);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, "rgba(99, 102, 241, 0.25)");
    grad.addColorStop(1, "rgba(99, 102, 241, 0.02)");
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + i * stepX;
      const y = toY(Number(data[i].focus_score) || 0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  };

  // expose
  global.EyeViz = EyeViz;
})(window);
