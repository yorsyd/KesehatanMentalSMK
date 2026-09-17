/**
 * Eye Focus Tracker — vanilla JS port (dari Vue v5 + eye5.py)
 *
 * Berisi:
 *  1. FocusTracker — algoritma inti (proportional scoring, EMA, hysteresis,
 *     blink/drowsy state machine, peak saccade detection, kalibrasi 5-titik).
 *  2. EyeTracker — pengontrol kamera + MediaPipe FaceLandmarker + session.
 *
 * Dipakai oleh deteksi-fokus.html & deteksi-emosi.html (dijalankan
 * bersamaan dengan perekaman emosi).
 */
(function (global) {
  "use strict";

  // ── Sumber lokal MediaPipe (tanpa CDN — tahan blokir ISP) ──
  const MEDIAPIPE_WASM = "/templates/js/mediapipe/wasm";
  const FACE_MODEL_PATH = "/templates/js/mediapipe/models/face_landmarker.task";

  // ── Indeks landmark mata (konvensi resmi MediaPipe FaceMesh) ──
  // LEFT_EYE / RIGHT_EYE = kontur penuh 16 titik (FACEMESH_LEFT_EYE / RIGHT_EYE)
  const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 466, 388, 387, 386, 385, 384, 398, 362];
  const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 246, 161, 160, 159, 158, 157, 173, 133];
  // 6 titik untuk EAR (urutan: [outer, upper1, upper2, inner, lower1, lower2])
  const LEFT_EYE_EAR = [362, 385, 387, 263, 373, 380];
  const RIGHT_EYE_EAR = [33, 160, 158, 133, 153, 144];
  const LEFT_IRIS = [474, 475, 476, 477];
  const RIGHT_IRIS = [469, 470, 471, 472];
  const NOSE_TIP = 1;
  // Sudut mata (pojok luar/dalam) — dipakai untuk lebar mata & head pose
  const LEFT_EYE_OUTER = 362;
  const LEFT_EYE_INNER = 263;
  const RIGHT_EYE_OUTER = 33;
  const RIGHT_EYE_INNER = 133;
  // Pipi (sejajar dengan sisi mata kiri/kanan) untuk estimasi head pose
  const LEFT_CHEEK = 454;
  const RIGHT_CHEEK = 234;

  // ── Helpers geometri ──
  function getPoint(landmarks, idx, w, h) {
    return { x: landmarks[idx].x * w, y: landmarks[idx].y * h };
  }
  function distance(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }
  function eyeAspectRatio(points) {
    const A = distance(points[1], points[5]);
    const B = distance(points[2], points[4]);
    const C = distance(points[0], points[3]);
    return (A + B) / (2.0 * C + 1e-6);
  }
  function estimateIrisDiameter(irisPts) {
    return distance(irisPts[1], irisPts[3]);
  }
  function normalizeIrisDiameter(irisDiam, eyeWidth) {
    return irisDiam / (eyeWidth + 1e-6);
  }
  function getBrightness(frame, centerX, centerY, radius = 10) {
    const w = frame.width;
    const h = frame.height;
    const data = frame.data;
    const cx = Math.round(centerX);
    const cy = Math.round(centerY);
    let sum = 0;
    let count = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px >= 0 && px < w && py >= 0 && py < h) {
          const i = (py * w + px) * 4;
          const value = Math.max(data[i], data[i + 1], data[i + 2]);
          sum += value;
          count++;
        }
      }
    }
    return count > 0 ? sum / count : 0;
  }
  function computeRelativeGaze(irisCenter, eyeCenter, eyeWidth, eyeHeight) {
    const relX = (irisCenter.x - eyeCenter.x) / (eyeWidth + 1e-6);
    const relY = (irisCenter.y - eyeCenter.y) / (eyeHeight + 1e-6);
    return { x: relX, y: relY };
  }
  function estimateHeadPose(landmarks, w, h) {
    const nose = getPoint(landmarks, NOSE_TIP, w, h);
    const leftEye = getPoint(landmarks, LEFT_EYE_OUTER, w, h);
    const rightEye = getPoint(landmarks, RIGHT_EYE_OUTER, w, h);
    const leftCheek = getPoint(landmarks, LEFT_CHEEK, w, h);
    const rightCheek = getPoint(landmarks, RIGHT_CHEEK, w, h);
    const dLeft = distance(nose, leftEye);
    const dRight = distance(nose, rightEye);
    const asymmetry = dLeft / (dRight + 1e-6);
    const faceWLeft = distance(leftEye, leftCheek);
    const faceWRight = distance(rightEye, rightCheek);
    const faceAsymmetry = faceWLeft / (faceWRight + 1e-6);
    return { asymmetry, faceAsymmetry };
  }
  function computeGazeVelocity(currentGaze, history) {
    if (history.length < 2) return 0.0;
    const n = Math.min(5, history.length);
    const recent = history.slice(-n);
    let totalDist = 0.0;
    for (let i = 1; i < n; i++) {
      const dx = recent[i].x - recent[i - 1].x;
      const dy = recent[i].y - recent[i - 1].y;
      totalDist += Math.sqrt(dx * dx + dy * dy);
    }
    return totalDist / (n - 1);
  }
  function computeSaccadeVelocity(gazeHistory) {
    if (gazeHistory.length < 2) return 0.0;
    const n = Math.min(3, gazeHistory.length);
    const recent = gazeHistory.slice(-n);
    let maxStep = 0.0;
    for (let i = 1; i < n; i++) {
      const dx = recent[i].x - recent[i - 1].x;
      const dy = recent[i].y - recent[i - 1].y;
      const step = Math.sqrt(dx * dx + dy * dy);
      if (step > maxStep) maxStep = step;
    }
    return maxStep;
  }
  function standardDeviation(arr) {
    if (arr.length === 0) return 0.0;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }
  function computeGazeEntropy(gazeHistory, bins = 5) {
    if (gazeHistory.length < 5) return 0.0;
    const xVals = gazeHistory.map((g) => g.x);
    const yVals = gazeHistory.map((g) => g.y);
    const xMin = Math.min(...xVals);
    const xMax = Math.max(...xVals);
    const yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    const grid = Array(bins)
      .fill(0)
      .map(() => Array(bins).fill(0));
    const binWidth = (xMax - xMin + 0.01) / bins;
    const binHeight = (yMax - yMin + 0.01) / bins;
    for (const g of gazeHistory) {
      const xi = Math.min(Math.floor((g.x - xMin) / binWidth), bins - 1);
      const yi = Math.min(Math.floor((g.y - yMin) / binHeight), bins - 1);
      grid[xi][yi]++;
    }
    let entropy = 0.0;
    const total = gazeHistory.length;
    for (let i = 0; i < bins; i++) {
      for (let j = 0; j < bins; j++) {
        if (grid[i][j] > 0) {
          const p = grid[i][j] / total;
          entropy -= p * Math.log2(p);
        }
      }
    }
    return entropy;
  }

  const BlinkState = { AWAKE: 0, BLINK_CHECK: 1, DROWSY: 2 };

  // ── Threshold default ──
  const DEFAULTS = {
    earDrowsyThreshold: 0.175,
    earFocusThreshold: 0.22,
    blinkMaxDuration: 0.4,
    drowsyMinDuration: 0.7,
    gazeRatioThreshold: 0.12,
    relativeGazeFixationThreshold: 0.08,
    relativeGazeFixationExitThreshold: 0.18,
    relativeGazeSaccadeThreshold: 0.2,
    scoreEar: 10,
    scoreGaze: 20,
    scoreFixation: 25,
    scoreSaccadeLow: 15,
    scoreScreen: 15,
    scoreBlinkPenalty: -5,
    focusHighThreshold: 65,
    focusMediumThreshold: 40,
    headTurnThreshold: 0.3,
    gazeAwayThresholdX: 0.35,
    gazeAwayThresholdY: 0.25,
  };

  // ──────────────────────────────────────────────
  //  FocusTracker
  // ──────────────────────────────────────────────
  class FocusTracker {
    constructor(opts) {
      this._opts = { ...DEFAULTS };
      for (const key of Object.keys(DEFAULTS)) {
        if (opts[key] != null) this._opts[key] = opts[key];
      }
      this._earBuffer = [];
      this._maxEarBuffer = 5;
      this._gazeHistory = [];
      this._maxGazeHistory = 30;
      this._irisDiameterHistory = [];
      this._maxIrisHistory = 10;
      this._normalizedIrisHistory = [];
      this._maxNormalizedIrisHistory = 30;
      this._focusBuffer = [];
      this._maxFocusBuffer = 20;
      this._smoothedFocus = 0;

      this._blinkState = BlinkState.AWAKE;
      this._blinkTimer = 0;
      this._blinkCount = 0;
      this._lastBlinkTime = 0;
      this._drowsyTimer = 0;
      this._isBlinking = false;
      this._isDrowsy = false;

      this._lastRelativeGaze = null;
      this._lastTime = performance.now();
      this._fixationTimer = 0;
      this._saccadeCount = 0;
      this._isFixating = false;
      this._isSaccade = false;

      this._lookingAtScreen = true;
      this._screenScore = 1.0;

      this._anxietyLevel = "LOW";
      this._anxietyScore = 0;
      this._irisVariability = 0;
      this._saccadeRate = 0;
      this._gazeEntropy = 0;
      this._fixationStability = 0;
      this._blinkRate = 0;
      this._anxietyHistory = [];
      this._maxAnxietyHistory = 90;

      this._calibrated = false;
      this._calibrating = false;
      this._calibrationState = "IDLE";
      this._currentCalibrationPoint = null;
      this._calibrationPoints = new Map();
      this._calibrationFramesAtPoint = 0;
      this._calibrationFramesTarget = 20;
      this._calibrationMapping = null;
      this._calibrationBounds = null;

      this._frameCount = 0;
    }

    updateOpts(opts) {
      for (const key of Object.keys(DEFAULTS)) {
        if (opts[key] != null) this._opts[key] = opts[key];
      }
    }

    startCalibration() {
      this._calibrating = true;
      this._calibrated = false;
      this._calibrationState = "IDLE";
      this._currentCalibrationPoint = null;
      this._calibrationPoints.clear();
      this._calibrationFramesAtPoint = 0;
      this._calibrationMapping = null;
      this._calibrationBounds = null;
    }

    setCalibrationPoint(pointId, screenX, screenY) {
      this._calibrationState = "COLLECTING";
      this._currentCalibrationPoint = { id: pointId, screenX, screenY };
      this._calibrationFramesAtPoint = 0;
      if (!this._calibrationPoints.has(pointId)) {
        this._calibrationPoints.set(pointId, { screenX, screenY, gazeData: [] });
      } else {
        this._calibrationPoints.get(pointId).gazeData = [];
      }
    }

    collectCalibrationFrame(relGazeX, relGazeY) {
      if (this._calibrationState !== "COLLECTING" || !this._currentCalibrationPoint) {
        return 0;
      }
      const point = this._calibrationPoints.get(this._currentCalibrationPoint.id);
      if (point && point.gazeData.length < this._calibrationFramesTarget) {
        point.gazeData.push({ x: relGazeX, y: relGazeY });
        this._calibrationFramesAtPoint = point.gazeData.length;
      }
      return this._calibrationFramesAtPoint;
    }

    finishCalibrationPoint() {
      this._calibrationState = "WAITING";
      this._currentCalibrationPoint = null;
      this._calibrationFramesAtPoint = 0;
    }

    computeCalibrationMapping() {
      if (this._calibrationPoints.size < 5) return false;
      const avgGaze = new Map();
      for (const [pointId, point] of this._calibrationPoints) {
        const avgX = point.gazeData.reduce((s, g) => s + g.x, 0) / point.gazeData.length;
        const avgY = point.gazeData.reduce((s, g) => s + g.y, 0) / point.gazeData.length;
        avgGaze.set(pointId, { x: avgX, y: avgY, screenX: point.screenX, screenY: point.screenY });
      }
      const topLeft = avgGaze.get("top-left");
      const topRight = avgGaze.get("top-right");
      const center = avgGaze.get("center");
      const bottomLeft = avgGaze.get("bottom-left");
      const bottomRight = avgGaze.get("bottom-right");
      if (!topLeft || !topRight || !center || !bottomLeft || !bottomRight) return false;

      const gazeMinX = Math.min(topLeft.x, bottomLeft.x);
      const gazeMaxX = Math.max(topRight.x, bottomRight.x);
      const gazeMinY = Math.min(topLeft.y, topRight.y);
      const gazeMaxY = Math.max(bottomLeft.y, bottomRight.y);

      this._calibrationMapping = {
        gazeMinX, gazeMaxX, gazeMinY, gazeMaxY,
        gazeCenterX: center.x, gazeCenterY: center.y,
        screenMinX: 0.08, screenMaxX: 0.92,
        screenMinY: 0.08, screenMaxY: 0.92,
        screenCenterX: 0.5, screenCenterY: 0.5,
      };
      this._calibrationBounds = {
        minX: gazeMinX - 0.1, maxX: gazeMaxX + 0.1,
        minY: gazeMinY - 0.1, maxY: gazeMaxY + 0.1,
      };
      this._calibrated = true;
      this._calibrating = false;
      this._calibrationState = "COMPLETE";
      return true;
    }

    applyCalibratedGaze(relGaze) {
      if (!this._calibrated || !this._calibrationMapping) return relGaze;
      const m = this._calibrationMapping;
      const normalizedX =
        (relGaze.x - m.gazeCenterX) / ((m.gazeMaxX - m.gazeMinX) / 2 + 0.01);
      const normalizedY =
        (relGaze.y - m.gazeCenterY) / ((m.gazeMaxY - m.gazeMinY) / 2 + 0.01);
      return { x: normalizedX, y: normalizedY };
    }

    get isCalibrating() { return this._calibrating; }
    get calibrationState() { return this._calibrationState; }
    get currentCalibrationPoint() { return this._currentCalibrationPoint; }
    get calibrationFramesAtPoint() { return this._calibrationFramesAtPoint; }

    process(landmarks, videoW, videoH, imageData) {
      const w = videoW;
      const h = videoH;
      this._frameCount++;

      const leftIrisPts = LEFT_IRIS.map((idx) => getPoint(landmarks, idx, w, h));
      const rightIrisPts = RIGHT_IRIS.map((idx) => getPoint(landmarks, idx, w, h));

      const leftIrisCenter = {
        x: leftIrisPts.reduce((s, p) => s + p.x, 0) / leftIrisPts.length,
        y: leftIrisPts.reduce((s, p) => s + p.y, 0) / leftIrisPts.length,
      };
      const rightIrisCenter = {
        x: rightIrisPts.reduce((s, p) => s + p.x, 0) / rightIrisPts.length,
        y: rightIrisPts.reduce((s, p) => s + p.y, 0) / rightIrisPts.length,
      };

      // Sudut mata (pojok luar/dalam) dari indeks landmark
      const leftOuter  = getPoint(landmarks, LEFT_EYE_OUTER, w, h);
      const leftInner  = getPoint(landmarks, LEFT_EYE_INNER, w, h);
      const rightOuter = getPoint(landmarks, RIGHT_EYE_OUTER, w, h);
      const rightInner = getPoint(landmarks, RIGHT_EYE_INNER, w, h);
      const leftEyeCenter = {
        x: (leftOuter.x + leftInner.x) / 2,
        y: (leftOuter.y + leftInner.y) / 2,
      };
      const rightEyeCenter = {
        x: (rightOuter.x + rightInner.x) / 2,
        y: (rightOuter.y + rightInner.y) / 2,
      };

      // ── EAR (dari 6 titik kelopak mata) ──
      const leftEarPts = LEFT_EYE_EAR.map((idx) => getPoint(landmarks, idx, w, h));
      const rightEarPts = RIGHT_EYE_EAR.map((idx) => getPoint(landmarks, idx, w, h));
      const leftEAR = eyeAspectRatio(leftEarPts);
      const rightEAR = eyeAspectRatio(rightEarPts);
      const ear = (leftEAR + rightEAR) / 2.0;
      this._earBuffer.push(ear);
      if (this._earBuffer.length > this._maxEarBuffer) this._earBuffer.shift();
      const smoothEar =
        this._earBuffer.reduce((s, v) => s + v, 0) / this._earBuffer.length;

      // ── Iris diameter ──
      const dLeft = estimateIrisDiameter(leftIrisPts);
      const dRight = estimateIrisDiameter(rightIrisPts);
      const irisDiam = (dLeft + dRight) / 2.0;
      this._irisDiameterHistory.push(irisDiam);
      if (this._irisDiameterHistory.length > this._maxIrisHistory) this._irisDiameterHistory.shift();
      const avgIrisDiam =
        this._irisDiameterHistory.reduce((s, v) => s + v, 0) / this._irisDiameterHistory.length;

      const leftEyeWidth = distance(leftOuter, leftInner);
      const rightEyeWidth = distance(rightOuter, rightInner);
      const leftEyeHeight = (distance(leftEarPts[1], leftEarPts[5]) + distance(leftEarPts[2], leftEarPts[4])) / 2;
      const rightEyeHeight = (distance(rightEarPts[1], rightEarPts[5]) + distance(rightEarPts[2], rightEarPts[4])) / 2;
      const avgEyeWidth = (leftEyeWidth + rightEyeWidth) / 2.0;
      const normalizedIris = normalizeIrisDiameter(irisDiam, avgEyeWidth);
      this._normalizedIrisHistory.push(normalizedIris);
      if (this._normalizedIrisHistory.length > this._maxNormalizedIrisHistory) this._normalizedIrisHistory.shift();

      // ── Relative gaze ──
      const leftRelGaze = computeRelativeGaze(leftIrisCenter, leftEyeCenter, leftEyeWidth, leftEyeHeight);
      const rightRelGaze = computeRelativeGaze(rightIrisCenter, rightEyeCenter, rightEyeWidth, rightEyeHeight);
      const relGaze = {
        x: (leftRelGaze.x + rightRelGaze.x) / 2.0,
        y: (leftRelGaze.y + rightRelGaze.y) / 2.0,
      };
      this._gazeHistory.push(relGaze);
      if (this._gazeHistory.length > this._maxGazeHistory) this._gazeHistory.shift();

      // ── Head pose ──
      const { asymmetry, faceAsymmetry } = estimateHeadPose(landmarks, w, h);

      // ── Gaze velocity ──
      const gazeVelocity = computeGazeVelocity(relGaze, this._gazeHistory);
      const saccadeVelocity = computeSaccadeVelocity(this._gazeHistory);

      // ── Brightness ──
      let brightness = 0;
      if (imageData) {
        brightness = getBrightness(imageData, rightIrisCenter.x, rightIrisCenter.y);
      }

      // ── Blink / drowsy state machine ──
      const now = performance.now();
      const dt = (now - this._lastTime) / 1000;
      this._isBlinking = false;
      this._isDrowsy = false;
      if (this._blinkState === BlinkState.AWAKE) {
        if (smoothEar < this._opts.earDrowsyThreshold) {
          this._blinkState = BlinkState.BLINK_CHECK;
          this._blinkTimer = 0;
        }
      } else if (this._blinkState === BlinkState.BLINK_CHECK) {
        this._blinkTimer += dt;
        if (smoothEar >= this._opts.earDrowsyThreshold) {
          if (this._blinkTimer <= this._opts.blinkMaxDuration) {
            this._blinkCount++;
            this._lastBlinkTime = now;
            this._isBlinking = true;
          }
          this._blinkState = BlinkState.AWAKE;
        } else if (this._blinkTimer >= this._opts.drowsyMinDuration) {
          this._blinkState = BlinkState.DROWSY;
          this._drowsyTimer = this._blinkTimer;
        }
      } else if (this._blinkState === BlinkState.DROWSY) {
        this._drowsyTimer += dt;
        this._isDrowsy = true;
        if (smoothEar >= this._opts.earFocusThreshold) {
          if (this._blinkTimer > 0.1) {
            this._blinkState = BlinkState.AWAKE;
            this._drowsyTimer = 0;
          }
        }
      }

      // ── Fixation (hysteresis) ──
      if (this._isFixating) {
        if (gazeVelocity > this._opts.relativeGazeFixationExitThreshold) {
          this._isFixating = false;
          this._fixationTimer = 0;
        } else {
          this._fixationTimer += dt;
        }
      } else {
        if (gazeVelocity < this._opts.relativeGazeFixationThreshold) {
          this._isFixating = true;
          this._fixationTimer += dt;
        } else {
          this._fixationTimer = 0;
        }
      }

      // ── Saccade (peak) ──
      this._isSaccade = false;
      if (saccadeVelocity > this._opts.relativeGazeSaccadeThreshold) {
        if (!this._isDrowsy) {
          this._saccadeCount++;
          this._isSaccade = true;
          this._isFixating = false;
          this._fixationTimer = 0;
        }
      }

      // ── Screen detection ──
      const signals = [];
      const headTurned =
        faceAsymmetry < 1.0 - this._opts.headTurnThreshold ||
        faceAsymmetry > 1.0 + this._opts.headTurnThreshold;
      signals.push(headTurned ? 0.0 : 1.0);
      const gazeAway =
        Math.abs(relGaze.x) > this._opts.gazeAwayThresholdX ||
        Math.abs(relGaze.y) > this._opts.gazeAwayThresholdY;
      signals.push(gazeAway ? 0.3 : 1.0);
      signals.push(this._isDrowsy ? 0.0 : 1.0);
      const gazeCentered =
        Math.abs(relGaze.x) < this._opts.gazeRatioThreshold &&
        Math.abs(relGaze.y) < this._opts.gazeRatioThreshold;
      signals.push(gazeCentered ? 1.0 : 0.5);
      this._screenScore = signals.reduce((s, v) => s + v, 0) / signals.length;
      this._lookingAtScreen = this._screenScore >= 0.5;

      // ── Anxiety ──
      this._irisVariability = standardDeviation(this._normalizedIrisHistory);
      const sessionDurationSec = (now - this._lastTime) / 1000 + 0.001;
      const sessionDurationMin = Math.max(sessionDurationSec / 60, 0.016);
      this._saccadeRate = this._saccadeCount / sessionDurationMin;
      this._blinkRate = this._blinkCount / sessionDurationMin;
      this._gazeEntropy = computeGazeEntropy(this._gazeHistory);
      if (this._isFixating && this._gazeHistory.length >= 5) {
        const recentGaze = this._gazeHistory.slice(-5);
        const xVals = recentGaze.map((g) => g.x);
        const yVals = recentGaze.map((g) => g.y);
        const xVar = standardDeviation(xVals);
        const yVar = standardDeviation(yVals);
        this._fixationStability = Math.sqrt(xVar * xVar + yVar * yVar);
      }
      const irisAnxiety = Math.min(100, (this._irisVariability / 0.15) * 100);
      const saccadeAnxiety = Math.min(100, (this._saccadeRate / 120) * 100);
      const entropyAnxiety = Math.min(100, (this._gazeEntropy / 4.0) * 100);
      const fixationAnxiety = Math.min(100, (this._fixationStability / 0.3) * 100);
      const blinkAnxiety = Math.min(100, Math.max(0, (this._blinkRate - 15) / 30) * 100);
      this._anxietyScore = Math.round(
        irisAnxiety * 0.3 + saccadeAnxiety * 0.25 + entropyAnxiety * 0.2 +
        fixationAnxiety * 0.15 + blinkAnxiety * 0.1
      );
      this._anxietyHistory.push({ timestamp: now, score: this._anxietyScore });
      if (this._anxietyHistory.length > this._maxAnxietyHistory) this._anxietyHistory.shift();
      const recentAnxiety = this._anxietyHistory.slice(-30);
      const avgAnxiety = recentAnxiety.reduce((s, a) => s + a.score, 0) / recentAnxiety.length;
      if (avgAnxiety >= 60) this._anxietyLevel = "HIGH";
      else if (avgAnxiety >= 30) this._anxietyLevel = "MEDIUM";
      else this._anxietyLevel = "LOW";

      // ── Focus score (proportional) ──
      const gazeMag = Math.sqrt(relGaze.x * relGaze.x + relGaze.y * relGaze.y);
      let focusScore = 15;
      if (smoothEar >= 0.25 && smoothEar <= 0.35) {
        focusScore += 10;
      } else if (smoothEar > 0.35 && smoothEar <= 0.45) {
        focusScore += 10 * (1 - (smoothEar - 0.35) / 0.1);
      } else if (smoothEar > 0.45) {
        focusScore += 0;
      } else if (smoothEar > 0.15 && smoothEar < 0.25) {
        focusScore += ((smoothEar - 0.15) / 0.1) * 10;
      }
      if (gazeMag < 0.05) {
        focusScore += 20;
      } else if (gazeMag < 0.25) {
        focusScore += 20 * (1 - (gazeMag - 0.05) / 0.2);
      }
      if (this._isFixating) {
        const fixationConfidence = Math.max(0, 1 - gazeVelocity / 0.25);
        focusScore += 25 * fixationConfidence;
      }
      if (this._saccadeCount < 20) {
        focusScore += 15;
      } else if (this._saccadeCount < 100) {
        focusScore += 15 * (1 - (this._saccadeCount - 20) / 80);
      }
      focusScore += this._screenScore * 15;
      if (this._blinkCount > 0) {
        focusScore -= Math.min(15, this._blinkCount * 0.33);
      }
      const ALPHA = 0.1;
      if (this._frameCount <= 1) {
        this._smoothedFocus = focusScore;
      } else {
        this._smoothedFocus = ALPHA * focusScore + (1 - ALPHA) * this._smoothedFocus;
      }
      const normalizedScore = Math.min(100, Math.max(0, Math.round(this._smoothedFocus)));

      // ── Status ──
      let status;
      if (this._isDrowsy) status = "MENGANTUK";
      else if (!this._lookingAtScreen) status = "TDK_FOKUS";
      else if (normalizedScore >= this._opts.focusHighThreshold) status = "FOKUS";
      else if (normalizedScore >= this._opts.focusMediumThreshold) status = "KURANG_FOKUS";
      else status = "TDK_FOKUS";

      this._lastTime = now;

      return {
        status,
        focus_score: normalizedScore,
        ear: +smoothEar.toFixed(3),
        iris_diam: +avgIrisDiam.toFixed(1),
        normalized_iris: +normalizedIris.toFixed(4),
        gaze_x: +relGaze.x.toFixed(3),
        gaze_y: +relGaze.y.toFixed(3),
        gaze_ratio: +Math.sqrt(relGaze.x * relGaze.x + relGaze.y * relGaze.y).toFixed(3),
        motion_speed: +gazeVelocity.toFixed(2),
        fixation_time: +this._fixationTimer.toFixed(2),
        saccade_count: this._saccadeCount,
        brightness: +brightness.toFixed(1),
        face_detected: true,
        is_blinking: this._isBlinking,
        is_drowsy: this._isDrowsy,
        is_fixating: this._isFixating,
        is_saccade: this._isSaccade,
        looking_at_screen: this._lookingAtScreen,
        screen_score: +this._screenScore.toFixed(2),
        blink_count: this._blinkCount,
        gaze_velocity: +gazeVelocity.toFixed(2),
        saccade_velocity: +saccadeVelocity.toFixed(3),
        face_asymmetry: +faceAsymmetry.toFixed(2),
        calibrated: this._calibrated,
        anxiety_level: this._anxietyLevel,
        anxiety_score: this._anxietyScore,
        anxiety_indicators: {
          iris_variability: +this._irisVariability.toFixed(4),
          saccade_rate: +this._saccadeRate.toFixed(1),
          gaze_entropy: +this._gazeEntropy.toFixed(2),
          fixation_stability: +this._fixationStability.toFixed(3),
          blink_rate: +this._blinkRate.toFixed(1),
        },
      };
    }

    reset() {
      this._earBuffer = [];
      this._gazeHistory = [];
      this._irisDiameterHistory = [];
      this._normalizedIrisHistory = [];
      this._focusBuffer = [];
      this._smoothedFocus = 0;
      this._blinkState = BlinkState.AWAKE;
      this._blinkTimer = 0;
      this._blinkCount = 0;
      this._drowsyTimer = 0;
      this._isBlinking = false;
      this._isDrowsy = false;
      this._fixationTimer = 0;
      this._saccadeCount = 0;
      this._isFixating = false;
      this._isSaccade = false;
      this._lastRelativeGaze = null;
      this._lastTime = performance.now();
      this._lookingAtScreen = true;
      this._screenScore = 1.0;
      this._anxietyLevel = "LOW";
      this._anxietyScore = 0;
      this._irisVariability = 0;
      this._saccadeRate = 0;
      this._gazeEntropy = 0;
      this._fixationStability = 0;
      this._blinkRate = 0;
      this._anxietyHistory = [];
      this._calibrating = false;
      this._calibrationState = "IDLE";
      this._currentCalibrationPoint = null;
      this._calibrationFramesAtPoint = 0;
      this._frameCount = 0;
    }
  }

  // ──────────────────────────────────────────────
  //  EyeTracker — kontrol kamera + MediaPipe + session
  // ──────────────────────────────────────────────
  class EyeTracker {
    /**
     * @param {Object} opts
     *   video   : HTMLElement video
     *   canvas  : HTMLElement canvas (overlay landmarks, opsional)
     *   mirrored: boolean
     *   thresholds: Object (default DEFAULTS)
     *   onData  : fn(data)  — data fokus per ~66ms
     *   onError : fn(msg)
     *   onCalibrationChange : fn({state, progress})
     */
    constructor(opts) {
      opts = opts || {};
      this.video = opts.video || null;
      this.canvas = opts.canvas || null;
      this.mirrored = opts.mirrored !== false;
      this.thresholds = Object.assign({}, DEFAULTS, opts.thresholds || {});
      this.onData = opts.onData || null;
      this.onError = opts.onError || null;
      this.onCalibrationChange = opts.onCalibrationChange || null;

      this.tracker = null;
      this.stream = null;
      this.faceLandmarker = null;
      this.animFrame = null;
      this.canvasCtx = this.canvas ? this.canvas.getContext("2d") : null;
      this.tempCanvas = document.createElement("canvas");
      this.tempCtx = this.tempCanvas.getContext("2d");

      this.modelLoaded = false;
      this.modelLoadPromise = null;
      this.running = false;
      this.lastEmitTime = 0;

      // Session
      this.sessionActive = false;
      this.sessionId = null;
      this.sessionStart = null;
      this.sessionEnd = null;
      this.history = [];
      this.statusCounts = { FOKUS: 0, KURANG_FOKUS: 0, TDK_FOKUS: 0, MENGANTUK: 0, NO_FACE: 0 };

      // Calibration
      this.calibrating = false;
      this.calibrationState = "IDLE";
      this.currentPointIndex = 0;
      this.isCollecting = false;
      this.isComplete = false;
      this.framesCollected = 0;
      this.framesTarget = 20;
      this.faceDetected = false;
      this.CALIBRATION_POINTS = [
        { id: "top-left", x: 0.08, y: 0.08, label: "Pojok Kiri Atas" },
        { id: "top-right", x: 0.92, y: 0.08, label: "Pojok Kanan Atas" },
        { id: "center", x: 0.5, y: 0.5, label: "Tengah" },
        { id: "bottom-left", x: 0.08, y: 0.92, label: "Pojok Kiri Bawah" },
        { id: "bottom-right", x: 0.92, y: 0.92, label: "Pojok Kanan Bawah" },
      ];
    }

    get isCalibrated() {
      return this.tracker ? this.tracker._calibrated : false;
    }

    // ── Model MediaPipe ──
    async loadModel() {
      if (this.modelLoaded) return true;
      if (this.modelLoadPromise) return this.modelLoadPromise;

      this.modelLoadPromise = this._loadModel();
      return this.modelLoadPromise;
    }

    async _loadModel() {
      try {
        if (!global.FilesetResolver || !global.FaceLandmarker) {
          await new Promise((resolve, reject) => {
            const onReady = () => {
              clearTimeout(timeout);
              resolve();
            };
            const timeout = setTimeout(() => {
              global.removeEventListener("mediapipe-ready", onReady);
              reject(new Error("Pustaka MediaPipe lokal belum termuat."));
            }, 10000);
            global.addEventListener("mediapipe-ready", onReady, { once: true });
          });
        }
        const vision = await global.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
        const makeOptions = (delegate) => ({
          baseOptions: {
            modelAssetPath: FACE_MODEL_PATH,
            delegate,
          },
          runningMode: "VIDEO",
          numFaces: 1,
          minFaceDetectionConfidence: 0.7,
          minTrackingConfidence: 0.7,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
        try {
          // Coba GPU dulu (lebih cepat)
          this.faceLandmarker = await global.FaceLandmarker.createFromOptions(vision, makeOptions("GPU"));
        } catch (gpuErr) {
          console.warn("[EyeTracker] GPU delegate gagal, mencoba CPU:", gpuErr && gpuErr.message);
          try {
            // Fallback ke CPU jika GPU/WebGL gagal di perangkat ini
            this.faceLandmarker = await global.FaceLandmarker.createFromOptions(vision, makeOptions("CPU"));
          } catch (cpuErr) {
            throw cpuErr;
          }
        }
        this.modelLoaded = true;
        return true;
      } catch (e) {
        console.error("[EyeTracker] loadModel gagal:", e);
        const detail = e && e.message ? " (" + e.message + ")" : "";
        if (this.onError) this.onError("Gagal memuat model AI" + detail);
        return false;
      } finally {
        if (!this.modelLoaded) this.modelLoadPromise = null;
      }
    }

    // ── Kamera ──
    async startCamera() {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
          audio: false,
        });
        if (this.video) {
          this.video.srcObject = this.stream;
          await this.video.play();
        }
        return true;
      } catch (e) {
        const msgs = {
          NotAllowedError: "Akses kamera ditolak. Izinkan akses kamera di browser.",
          NotFoundError: "Kamera tidak ditemukan di perangkat ini.",
          NotReadableError: "Kamera sedang digunakan aplikasi lain.",
          OverconstrainedError: "Kamera tidak mendukung resolusi yang diminta.",
        };
        if (this.onError) this.onError(msgs[e.name] || "Gagal mengakses kamera: " + e.message);
        return false;
      }
    }

    stopCamera() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.animFrame) {
        cancelAnimationFrame(this.animFrame);
        this.animFrame = null;
      }
      if (this.video) this.video.srcObject = null;
      if (this.canvasCtx && this.canvas) {
        this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.running = false;
    }

    // ── Draw landmarks ──
    drawLandmarks(landmarks, w, h) {
      const ctx = this.canvasCtx;
      if (!ctx || !this.canvas) return;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(99, 102, 241, 0.7)";
      ctx.lineWidth = Math.max(1, Math.round(w / 400));
      for (const eye of [LEFT_EYE, RIGHT_EYE]) {
        ctx.beginPath();
        for (let i = 0; i < eye.length; i++) {
          const p = landmarks[eye[i]];
          if (i === 0) ctx.moveTo(p.x * w, p.y * h);
          else ctx.lineTo(p.x * w, p.y * h);
        }
        ctx.closePath();
        ctx.stroke();
      }
      const irisRadius = Math.max(1.5, Math.round(w / 200));
      ctx.fillStyle = "rgba(251, 191, 36, 0.7)";
      for (const iris of [LEFT_IRIS, RIGHT_IRIS]) {
        for (const idx of iris) {
          const p = landmarks[idx];
          ctx.beginPath();
          ctx.arc(p.x * w, p.y * h, irisRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const iris of [LEFT_IRIS, RIGHT_IRIS]) {
        const pts = iris.map((idx) => landmarks[idx]);
        const cx = (pts.reduce((s, p) => s + p.x, 0) / pts.length) * w;
        const cy = (pts.reduce((s, p) => s + p.y, 0) / pts.length) * h;
        ctx.fillStyle = "#fbbf24";
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(2, Math.round(w / 150)), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Processing loop ──
    processFrame() {
      if (!this.faceLandmarker || !this.video || !this.running) {
        this.animFrame = requestAnimationFrame(() => this.processFrame());
        return;
      }
      const video = this.video;
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;

      if (this.canvas) {
        this.canvas.width = vw;
        this.canvas.height = vh;
      }

      if (video.readyState >= 2) {
        try {
          const result = this.faceLandmarker.detectForVideo(video, performance.now());
          this._errorCount = 0;
          if (result.faceLandmarks && result.faceLandmarks.length > 0) {
            const landmarks = result.faceLandmarks[0];
            if (this.canvas) this.drawLandmarks(landmarks, vw, vh);

            if (!this.tracker) this.tracker = new FocusTracker(this.thresholds);

            const now = Date.now();
            if (now - this.lastEmitTime > 66) {
              let imageData = null;
              if (this.tempCtx && vw > 0 && vh > 0) {
                if (this.tempCanvas.width !== vw || this.tempCanvas.height !== vh) {
                  this.tempCanvas.width = vw;
                  this.tempCanvas.height = vh;
                }
                this.tempCtx.drawImage(video, 0, 0, vw, vh);
                imageData = this.tempCtx.getImageData(0, 0, vw, vh);
              }
              const focusData = this.tracker.process(landmarks, vw, vh, imageData);
              this.faceDetected = true;
              this.updateCalibration(focusData);
              if (this.onData) this.onData(focusData);
              this.lastEmitTime = now;
            }
          } else {
            this.faceDetected = false;
            const now = Date.now();
            if (now - this.lastEmitTime > 66) {
              const noFace = {
                status: "NO_FACE", focus_score: 0, ear: 0, iris_diam: 0,
                gaze_x: 0, gaze_y: 0, motion_speed: 0, fixation_time: 0,
                saccade_count: 0, brightness: 0, face_detected: false,
                is_fixating: false, is_saccade: false,
              };
              if (this.onData) this.onData(noFace);
              this.lastEmitTime = now;
            }
          }
        } catch (e) {
          // Laporkan error berulang (mis. konteks GPU hilang) — jangan senyap
          this._errorCount = (this._errorCount || 0) + 1;
          if (this._errorCount === 5 && this.onError) {
            this.onError("Pelacakan terhenti: " + (e && e.message ? e.message : "error deteksi wajah."));
          }
          if (this._errorCount >= 30) {
            this.running = false;
            if (this.onError) this.onError("Eye tracking dihentikan karena error berulang.");
            return;
          }
        }
      }
      this.animFrame = requestAnimationFrame(() => this.processFrame());
    }

    // ── Kalibrasi ──
    startCalibration() {
      if (this.tracker) {
        this.tracker.startCalibration();
        this.calibrating = true;
        this.isComplete = false;
        this.isCollecting = false;
        this.currentPointIndex = 0;
        this.framesCollected = 0;
        this.calibrationState = "COLLECTING_POINT";
        this._emitCalibration();
      }
    }

    cancelCalibration() {
      if (this.tracker) {
        this.tracker._calibrating = false;
        this.tracker._calibrationState = "IDLE";
      }
      this.calibrating = false;
      this.isCollecting = false;
      this.isComplete = false;
      this.calibrationState = "IDLE";
      this._emitCalibration();
    }

    confirmPoint() {
      if (!this.tracker || !this.faceDetected) return;
      const pt = this.CALIBRATION_POINTS[this.currentPointIndex];
      this.tracker.setCalibrationPoint(pt.id, pt.x, pt.y);
      this.isCollecting = true;
      this.framesCollected = 0;
      this.calibrationState = "COLLECTING";
      this._emitCalibration();
    }

    finishCalibration() {
      this.calibrating = false;
      this.isComplete = false;
      this.calibrationState = "COMPLETE";
      this._emitCalibration();
    }

    updateCalibration(data) {
      if (!this.tracker || !this.calibrating) return;
      if (this.tracker.calibrationState === "COLLECTING") {
        const collected = this.tracker.collectCalibrationFrame(data.gaze_x, data.gaze_y);
        this.framesCollected = collected;
        if (collected >= this.framesTarget) {
          this.tracker.finishCalibrationPoint();
          this.isCollecting = false;
          if (this.currentPointIndex >= 4) {
            const success = this.tracker.computeCalibrationMapping();
            if (success) {
              this.isComplete = true;
              this.calibrationState = "COMPLETE";
            } else {
              this.startCalibration();
            }
          } else {
            this.currentPointIndex++;
            this.isCollecting = false;
            this.framesCollected = 0;
          }
          this._emitCalibration();
        }
      }
    }

    _emitCalibration() {
      if (this.onCalibrationChange) {
        this.onCalibrationChange({
          calibrating: this.calibrating,
          isComplete: this.isComplete,
          state: this.calibrationState,
          pointIndex: this.currentPointIndex,
          framesCollected: this.framesCollected,
          framesTarget: this.framesTarget,
          faceDetected: this.faceDetected,
        });
      }
    }

    // ── Session ──
    generateId() {
      return (
        Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).substring(2, 6).toUpperCase()
      );
    }

    startSession() {
      if (this.sessionActive) return;
      this.sessionActive = true;
      this.sessionId = this.generateId();
      this.sessionStart = Date.now();
      this.sessionEnd = null;
      this.history = [];
      this.statusCounts = { FOKUS: 0, KURANG_FOKUS: 0, TDK_FOKUS: 0, MENGANTUK: 0, NO_FACE: 0 };
      if (this.tracker) this.tracker.reset();
    }

    // Dipanggil di onData saat sessionActive — jangan rekam NO_FACE berlebihan
    recordData(data) {
      if (!this.sessionActive) return;
      // simpan semua frame (termasuk NO_FACE) untuk akurasi statistik
      this.history.push({
        gaze_x: data.gaze_x ?? 0,
        gaze_y: data.gaze_y ?? 0,
        focus_score: data.focus_score ?? 0,
        is_fixating: !!data.is_fixating,
        is_saccade: !!data.is_saccade,
        status: data.status ?? "NO_FACE",
      });
      this.statusCounts[data.status] = (this.statusCounts[data.status] || 0) + 1;
    }

    stopSession() {
      if (!this.sessionActive) return;
      this.sessionActive = false;
      this.sessionEnd = Date.now();
      return this.getSessionData();
    }

    getSessionData() {
      const n = this.history.length;
      const duration = this.sessionStart
        ? (this.sessionEnd || Date.now()) - this.sessionStart
        : 0;
      const avgFocus = n > 0
        ? Math.round(
            this.history.reduce((s, d) => s + (d.focus_score || 0), 0) / n
          )
        : 0;
      return {
        session_id: this.sessionId,
        duration: Math.round(duration / 1000),
        data_points: n,
        avg_focus: avgFocus,
        status_counts: { ...this.statusCounts },
        history: this.history, // full history (tanpa downsampling)
      };
    }
  }

  // ── expose ──
  global.FocusTracker = FocusTracker;
  global.EyeTracker = EyeTracker;
  global.TRACKER_DEFAULTS = DEFAULTS;
})(window);