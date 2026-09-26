import {S,$} from './state.js';
import {draw} from './canvas-draw.js';

// ---- mel spectrogram (0-5000 Hz) -------------------------------------------
const SPEC_PALETTE = [
  { p: 0.0,  r: 20,  g: 22,  b: 26 },   // matches app background #14161a
  { p: 0.15, r: 35,  g: 30,  b: 65 },   // deep navy purple
  { p: 0.35, r: 75,  g: 25,  b: 105 },  // rich violet
  { p: 0.55, r: 165, g: 35,  b: 65 },   // vibrant magenta/crimson
  { p: 0.75, r: 230, g: 95,  b: 30 },   // bright orange
  { p: 0.90, r: 250, g: 200, b: 60 },   // bright warm yellow
  { p: 1.0,  r: 255, g: 255, b: 240 }   // white/pale yellow
];
const SPEC_CMAP = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let idx = 0;
  while (idx < SPEC_PALETTE.length - 1 && SPEC_PALETTE[idx + 1].p < t) idx++;
  const c0 = SPEC_PALETTE[idx];
  const c1 = SPEC_PALETTE[Math.min(idx + 1, SPEC_PALETTE.length - 1)];
  const frac = c1.p === c0.p ? 0 : (t - c0.p) / (c1.p - c0.p);
  SPEC_CMAP[i * 3]     = Math.round(c0.r + frac * (c1.r - c0.r));
  SPEC_CMAP[i * 3 + 1] = Math.round(c0.g + frac * (c1.g - c0.g));
  SPEC_CMAP[i * 3 + 2] = Math.round(c0.b + frac * (c1.b - c0.b));
}

const hzToMel = hz => 2595 * Math.log10(1 + hz / 700);
const melToHz = mel => 700 * (Math.pow(10, mel / 2595) - 1);
function freqToY(hz, height, maxHz) {
  const m = hzToMel(Math.min(hz, maxHz));
  const maxM = hzToMel(maxHz);
  const frac = maxM > 0 ? m / maxM : 0;
  return height * (1 - frac);
}

function runFft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wstepR = Math.cos(ang), wstepI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const tr = wr * re[i + j + half] - wi * im[i + j + half];
        const ti = wr * im[i + j + half] + wi * re[i + j + half];
        re[i + j + half] = re[i + j] - tr;
        im[i + j + half] = im[i + j] - ti;
        re[i + j] += tr;
        im[i + j] += ti;
        const nextWr = wr * wstepR - wi * wstepI;
        wi = wr * wstepI + wi * wstepR;
        wr = nextWr;
      }
    }
  }
}

function prepareSnapDetector(data, numFrames, numBands, hop, sr, lead, n=4){
  if(!data||numFrames<2*n) return null;
  function l2(f1, f2){
    let sumSq=0;
    const o1=f1*numBands, o2=f2*numBands;
    for(let m=0;m<numBands;m++){
      const d=data[o1+m]-data[o2+m];
      sumSq+=d*d;
    }
    return Math.sqrt(sumSq);
  }

  // 1. Stable baseline: 200 random pairs across audio
  let sumDist=0;
  const numPairs=200;
  for(let i=0;i<numPairs;i++){
    const f1=Math.floor(Math.random()*numFrames);
    const f2=Math.floor(Math.random()*numFrames);
    sumDist+=l2(f1, f2);
  }
  const rawBaseline=sumDist/numPairs;

  // 2. Sliding window difference curve D (precomputed for all frames)
  const D=new Float32Array(numFrames);
  const avg1=new Float32Array(numBands);
  const avg2=new Float32Array(numBands);

  for(let f=0; f<=numFrames-2*n; f++){
    for(let m=0;m<numBands;m++){
      let s1=0, s2=0;
      for(let i=0;i<n;i++){
        s1+=data[(f+i)*numBands+m];
        s2+=data[(f+n+i)*numBands+m];
      }
      avg1[m]=s1/n;
      avg2[m]=s2/n;
    }
    let sumSq=0;
    for(let m=0;m<numBands;m++){
      const d=avg1[m]-avg2[m];
      sumSq+=d*d;
    }
    D[f+n]=Math.sqrt(sumSq);
  }

  return { D, rawBaseline, numFrames, hop, sr, lead, n };
}

function refreshSnapPoints(shouldDraw=true){
  if(!S.specData){ S.snapPoints=[]; return; }
  const { D, rawBaseline, numFrames, hop, sr, lead, n } = S.specData;
  const thresh = rawBaseline * S.snapThreshRatio;
  const minSepFrames = Math.max(1, Math.round((S.snapMinSepMs/1000)*sr/hop));

  // Local peak picking exceeding threshold
  const peaks=[];
  for(let f=n+1; f<numFrames-n-1; f++){
    if(D[f]>thresh && D[f]>D[f-1] && D[f]>=D[f+1]){
      peaks.push({frame:f, val:D[f], time:-lead+(f*hop)/sr});
    }
  }

  // Suppress minor secondary peaks within minSepFrames
  const filtered=[];
  for(let i=0; i<peaks.length; i++){
    const curr=peaks[i];
    if(!filtered.length){
      filtered.push(curr);
    }else{
      const prev=filtered[filtered.length-1];
      if(curr.frame-prev.frame < minSepFrames){
        if(curr.val > prev.val) filtered[filtered.length-1]=curr;
      }else{
        filtered.push(curr);
      }
    }
  }

  S.snapPoints = filtered.map(p=>p.time);
  if($('snapThreshVal')) $('snapThreshVal').textContent = S.snapThreshRatio.toFixed(2);
  if($('snapCountPill')) $('snapCountPill').textContent = S.snapPoints.length + ' snaps';
  if(shouldDraw) draw();
}

function buildMelSpec(audioBuffer) {
  if (!audioBuffer) return null;
  const sr = audioBuffer.sampleRate;
  const inp = audioBuffer.getChannelData(0);
  const totalSamples = inp.length;
  if (!totalSamples) return null;

  // Pre-emphasis filter: boosts higher speech formants and bursts
  const pre = new Float32Array(totalSamples);
  pre[0] = inp[0];
  for (let i = 1; i < totalSamples; i++) pre[i] = inp[i] - 0.97 * inp[i - 1];

  const nFft = sr <= 24000 ? 512 : 1024;
  const hop = Math.max(1, Math.round(sr * 0.005)); // 5ms hop for speech precision
  const numBands = 80;
  const maxHz = Math.min(5000, sr / 2);
  const minHz = 0;
  const maxBin = nFft >> 1;
  const pad = nFft >> 1;
  const numFrames = Math.floor(totalSamples / hop) + 1;

  // Periodic Hann window
  const win = new Float32Array(nFft);
  for (let i = 0; i < nFft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);

  // Mel filterbank
  const minMel = hzToMel(minHz);
  const maxMel = hzToMel(maxHz);
  const melStep = (maxMel - minMel) / (numBands + 1);
  const binPoints = new Float32Array(numBands + 2);
  for (let i = 0; i < numBands + 2; i++) {
    binPoints[i] = (melToHz(minMel + i * melStep) * nFft) / sr;
  }
  const filters = [];
  for (let m = 0; m < numBands; m++) {
    const center = binPoints[m + 1], left = binPoints[m], right = binPoints[m + 2];
    const kMin = Math.max(0, Math.floor(left)), kMax = Math.min(maxBin - 1, Math.ceil(right));
    const weights = [];
    for (let k = kMin; k <= kMax; k++) {
      let w = 0;
      if (k >= left && k <= center && center > left) w = (k - left) / (center - left);
      else if (k > center && k <= right && right > center) w = (right - k) / (right - center);
      if (w > 0) weights.push({ bin: k, w });
    }
    if (weights.length === 0) {
      weights.push({ bin: Math.max(0, Math.min(maxBin - 1, Math.round(center))), w: 1.0 });
    }
    filters.push(weights);
  }

  const re = new Float32Array(nFft);
  const im = new Float32Array(nFft);
  const power = new Float32Array(maxBin);
  const melSpec = new Float32Array(numFrames * numBands);
  const linearMel = new Float32Array(numFrames * numBands);
  let maxVal = -Infinity;

  for (let f = 0; f < numFrames; f++) {
    const centerSample = f * hop;
    const startSample = centerSample - pad;
    for (let i = 0; i < nFft; i++) {
      const s = startSample + i;
      re[i] = (s >= 0 && s < totalSamples ? pre[s] : 0) * win[i];
      im[i] = 0;
    }
    runFft(re, im);
    for (let k = 0; k < maxBin; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }
    for (let m = 0; m < numBands; m++) {
      let sum = 0;
      const flt = filters[m];
      for (let j = 0; j < flt.length; j++) {
        sum += power[flt[j].bin] * flt[j].w;
      }
      linearMel[f * numBands + m] = sum;
      const val = Math.log10(sum + 1e-7);
      melSpec[f * numBands + m] = val;
      if (val > maxVal) maxVal = val;
    }
  }

  const dynRange = 4.5; // 45 dB dynamic range
  const minVal = maxVal - dynRange;
  const normMel = new Float32Array(numFrames * numBands);

  const offscreen = document.createElement('canvas');
  offscreen.width = numFrames;
  offscreen.height = numBands;
  offscreen.maxHz = maxHz;
  const offCtx = offscreen.getContext('2d');
  const imgData = offCtx.createImageData(numFrames, numBands);
  const data = imgData.data;

  for (let f = 0; f < numFrames; f++) {
    for (let m = 0; m < numBands; m++) {
      const val = melSpec[f * numBands + m];
      const norm = Math.max(0, Math.min(1, (val - minVal) / dynRange));
      normMel[f * numBands + m] = norm;
      const ci = Math.min(255, Math.floor(norm * 255));
      const y = numBands - 1 - m; // 0Hz at bottom, 5000Hz at top
      const pIdx = (y * numFrames + f) * 4;
      data[pIdx]     = SPEC_CMAP[ci * 3];
      data[pIdx + 1] = SPEC_CMAP[ci * 3 + 1];
      data[pIdx + 2] = SPEC_CMAP[ci * 3 + 2];
      data[pIdx + 3] = 255;
    }
  }
  offCtx.putImageData(imgData, 0, 0);
  S.specData = prepareSnapDetector(normMel, numFrames, numBands, hop, sr, S.lead, 4);
  refreshSnapPoints(false);
  offscreen.snapPoints = S.snapPoints;
  return offscreen;
}

export {buildMelSpec, refreshSnapPoints, freqToY};
