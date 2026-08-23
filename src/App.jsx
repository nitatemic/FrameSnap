import { useState, useEffect, useRef, useMemo } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import {
  Video,
  Image as ImageIcon,
  Download,
  Settings,
  HelpCircle,
  Info,
  RefreshCw,
  FileVideo,
  Sparkles,
  Layers,
  Sun,
  Moon,
  ChevronDown,
  ChevronUp,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Zap,
  Crosshair,
  Gauge
} from 'lucide-react';
import './App.css';

// Helper to format bytes to human readable sizes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper to format timestamps to MM:SS.mmm or HH:MM:SS.mmm
function formatTimestamp(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return "N/A";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  
  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  }
  return `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

// Visual Fingerprint + sharpness analysis (single image decode)
function analyzeFrameImage(imgUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imgUrl;
    img.onload = () => {
      const result = { fingerprint: null, sharpness: 0 };

      const fpCanvas = document.createElement('canvas');
      fpCanvas.width = 16;
      fpCanvas.height = 16;
      const fpCtx = fpCanvas.getContext('2d', { willReadFrequently: true });
      if (fpCtx) {
        fpCtx.drawImage(img, 0, 0, 16, 16);
        try {
          result.fingerprint = fpCtx.getImageData(0, 0, 16, 16).data;
        } catch {
          result.fingerprint = null;
        }
      }

      const sW = 160;
      const ratio = img.naturalHeight / (img.naturalWidth || 1);
      const sH = Math.max(2, Math.round(ratio * sW) || 90);
      const sCanvas = document.createElement('canvas');
      sCanvas.width = sW;
      sCanvas.height = sH;
      const sCtx = sCanvas.getContext('2d', { willReadFrequently: true });
      if (sCtx) {
        sCtx.drawImage(img, 0, 0, sW, sH);
        try {
          const data = sCtx.getImageData(0, 0, sW, sH).data;
          const gray = new Float64Array(sW * sH);
          for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          }
          let sumLap = 0;
          let sumLapSq = 0;
          let count = 0;
          for (let y = 1; y < sH - 1; y++) {
            for (let x = 1; x < sW - 1; x++) {
              const idx = y * sW + x;
              const lap = 4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - sW] - gray[idx + sW];
              sumLap += lap;
              sumLapSq += lap * lap;
              count++;
            }
          }
          if (count > 0) {
            const mean = sumLap / count;
            result.sharpness = sumLapSq / count - mean * mean;
          }
        } catch {
          result.sharpness = 0;
        }
      }

      resolve(result);
    };
    img.onerror = () => resolve({ fingerprint: null, sharpness: 0 });
  });
}

// Compare two fingerprints (Mean Squared Error style distance)
function calculateDifference(fp1, fp2) {
  if (!fp1 || !fp2) return 100;
  let sumSquaredDiff = 0;
  let count = 0;
  for (let i = 0; i < fp1.length; i += 4) {
    const rDiff = fp1[i] - fp2[i];
    const gDiff = fp1[i+1] - fp2[i+1];
    const bDiff = fp1[i+2] - fp2[i+2];
    sumSquaredDiff += (rDiff * rDiff + gDiff * gDiff + bDiff * bDiff);
    count++;
  }
  const rms = Math.sqrt(sumSquaredDiff / (count * 3));
  return (rms / 255) * 100; // Returns 0% to 100%
}

const FAST_CHUNK_THRESHOLD_S = 120;
const THUMBNAIL_WINDOW_S = 2;
const MAX_UNBOUNDED_SEGMENTS = 500;

function parseFpsFromLogs(logs) {
  const videoLines = logs.filter(l => l.includes('Stream #') && l.includes('Video:'));
  for (const line of videoLines) {
    const m = line.match(/(\d+(?:\.\d+)?)\s*fps/i);
    if (m) return parseFloat(m[1]);
  }
  for (const line of videoLines) {
    const m = line.match(/(\d+(?:\.\d+)?)\s*tbr/i);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function parseDurationFromLogs(logs) {
  for (const line of logs) {
    const m = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    }
  }
  return null;
}

function parseShowinfoLogs(logs) {
  const infoMap = new Map();
  for (const log of logs) {
    if (!log.includes('Parsed_showinfo')) continue;
    const nMatch = log.match(/n:\s*(\d+)/);
    const ptsMatch = log.match(/pts_time:\s*([\d.e+-]+)/);
    const resMatch = log.match(/s:\s*(\d+x\d+)/);

    if (nMatch) {
      infoMap.set(parseInt(nMatch[1], 10), {
        timestamp: ptsMatch ? parseFloat(ptsMatch[1]) : null,
        resolution: resMatch ? resMatch[1] : null
      });
    }
  }
  return infoMap;
}

function App() {
  // App States
  const [theme, setTheme] = useState('dark');
  const [browserSupported, setBrowserSupported] = useState(true);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoMeta, setVideoMeta] = useState(null);
  const [videoFps, setVideoFps] = useState(null);
  const [rawFrames, setRawFrames] = useState([]);
  const [selectedFrame, setSelectedFrame] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [segmentInfo, setSegmentInfo] = useState(null);
  const [statusSteps, setStatusSteps] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState('all'); // all, unique, duplicates

  // Extraction Strategy States
  const [extractMode, setExtractMode] = useState('fast'); // fast, detailed
  const [segmentSeconds, setSegmentSeconds] = useState(10);

  // Advanced Settings States
  const [extractionLimit, setExtractionLimit] = useState(30);
  const [exportFormat, setExportFormat] = useState('png');
  const [exportQuality, setExportQuality] = useState(0.85);
  const [scaleResolution, setScaleResolution] = useState('original');
  const [dedupEnabled, setDedupEnabled] = useState(true);
  const [dedupThreshold, setDedupThreshold] = useState(4.0); // 4% difference
  const [sortOrder, setSortOrder] = useState('chrono'); // chrono, size, sharpness

  // Refs
  const ffmpegInstance = useRef(null);
  const ffmpegLogsRef = useRef([]);
  const progressCtxRef = useRef({ type: 'single', done: 0, total: 0 });
  const dropZoneRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);

  // Check WebAssembly Support
  useEffect(() => {
    const hasWasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
    setBrowserSupported(hasWasm);
  }, []);

  // Sync Theme
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light-theme');
    } else {
      document.documentElement.classList.remove('light-theme');
    }
  }, [theme]);

  // Clean up object URLs to prevent memory leaks
  const cleanupUrls = () => {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
    }
    rawFrames.forEach(f => {
      if (f.url) URL.revokeObjectURL(f.url);
    });
  };

  // Reset App / File selection
  const handleReset = () => {
    cleanupUrls();
    setVideoFile(null);
    setVideoMeta(null);
    setVideoFps(null);
    setRawFrames([]);
    setSelectedFrame(null);
    setErrorMessage(null);
    setProgress(0);
    setSegmentInfo(null);
  };

  // File loading helper
  const handleVideoSelect = (file) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setErrorMessage("Le fichier sélectionné n'est pas une vidéo valide.");
      return;
    }
    
    handleReset();
    setVideoFile(file);
    
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    
    // Read local duration & dimensions natively
    const tempVideo = document.createElement('video');
    tempVideo.src = url;
    tempVideo.preload = 'metadata';
    tempVideo.onloadedmetadata = () => {
      setVideoMeta({
        duration: tempVideo.duration,
        width: tempVideo.videoWidth,
        height: tempVideo.videoHeight,
        resolution: `${tempVideo.videoWidth}x${tempVideo.videoHeight}`
      });
    };
    tempVideo.onerror = () => {
      setErrorMessage("Impossible de lire les métadonnées de la vidéo. La vidéo est peut-être corrompue ou son codec n'est pas supporté par votre navigateur.");
    };
  };

  // Drag and Drop Handlers
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleVideoSelect(e.dataTransfer.files[0]);
    }
  };

  // Load FFmpeg WebAssembly on Demand
  const loadFFmpeg = async () => {
    if (ffmpegInstance.current && ffmpegLoaded) {
      return ffmpegInstance.current;
    }
    
    setFfmpegLoading(true);
    setErrorMessage(null);
    
    try {
      const ffmpeg = new FFmpeg();
      ffmpegInstance.current = ffmpeg;
      
      // Hook logs
      ffmpeg.on('log', ({ message }) => {
        console.log('FFmpeg:', message);
        ffmpegLogsRef.current.push(message);
      });
      
      // Hook progress (blended with chunk context when processing segments)
      ffmpeg.on('progress', ({ progress }) => {
        const ctx = progressCtxRef.current;
        if (ctx.type === 'chunk' && ctx.total > 0) {
          const clamped = Math.min(Math.max(progress, 0), 1);
          setProgress(Math.round(((ctx.done + clamped) / ctx.total) * 100));
        } else {
          setProgress(Math.round(progress * 100));
        }
      });
      
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
      
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      
      setFfmpegLoaded(true);
      setFfmpegLoading(false);
      return ffmpeg;
    } catch (err) {
      console.error('Failed to load FFmpeg.wasm:', err);
      setErrorMessage("Échec du chargement de FFmpeg.wasm. Assurez-vous d'être connecté à Internet. Sur certains navigateurs, l'isolation Cross-Origin (COOP/COEP) peut restreindre le chargement. Détail: " + err.message);
      setFfmpegLoading(false);
      setFfmpegLoaded(false);
      throw err;
    }
  };

  // Execute FFmpeg frame extraction
  const handleExtract = async () => {
    if (!videoFile) return;
    
    setProcessing(true);
    setProgress(0);
    setRawFrames([]);
    setSelectedFrame(null);
    setErrorMessage(null);
    
    ffmpegLogsRef.current = [];
    progressCtxRef.current = { type: 'single', done: 0, total: 0 };

    const steps = [
      { id: 'load', name: 'Initialisation de FFmpeg.wasm', status: 'active' },
      { id: 'write', name: 'Copie de la vidéo dans le stockage WASM', status: 'pending' },
      { id: 'probe', name: 'Analyse des métadonnées (framerate, durée)', status: 'pending' },
      { id: 'exec', name: "Extraction des images nettes (filtre thumbnail)", status: 'pending' },
      { id: 'read', name: 'Récupération et purge mémoire', status: 'pending' },
      { id: 'dedup', name: 'Analyse et déduplication visuelle', status: 'pending' }
    ];
    setStatusSteps(steps);
    
    const updateStep = (id, status) => {
      setStatusSteps(prev => prev.map(s => s.id === id ? { ...s, status } : s));
    };

    try {
      // Step 1: Init Engine
      let ffmpeg = ffmpegInstance.current;
      if (!ffmpegLoaded || !ffmpeg) {
        ffmpeg = await loadFFmpeg();
      }
      updateStep('load', 'completed');
      updateStep('write', 'active');
      
      const fileData = await fetchFile(videoFile);
      await ffmpeg.writeFile('input.mp4', fileData);
      updateStep('write', 'completed');
      updateStep('probe', 'active');

      try {
        await ffmpeg.exec(['-i', 'input.mp4']);
      } catch (probeErr) {
        console.warn(probeErr);
      }

      const probedFps = parseFpsFromLogs(ffmpegLogsRef.current);
      const probedDuration = parseDurationFromLogs(ffmpegLogsRef.current);
      setVideoFps(probedFps);
      updateStep('probe', 'completed');
      updateStep('exec', 'active');

      const safeFps = probedFps && probedFps > 0 ? probedFps : 30;
      const duration = videoMeta && Number.isFinite(videoMeta.duration) && videoMeta.duration > 0
        ? videoMeta.duration
        : probedDuration;
      const isDetailed = extractMode === 'detailed';
      const needsChunking = isDetailed || (duration !== null && duration > FAST_CHUNK_THRESHOLD_S);
      const thumbnailBatch = isDetailed
        ? Math.min(90, Math.max(8, Math.round(safeFps * THUMBNAIL_WINDOW_S)))
        : 2;

      const filters = [];
      if (!isDetailed) filters.push('fps=1');
      if (scaleResolution === 'half') {
        filters.push('scale=iw/2:-2');
      } else if (scaleResolution === 'quarter') {
        filters.push('scale=iw/4:-2');
      }
      filters.push(`thumbnail=${thumbnailBatch}`);
      filters.push('showinfo');
      const filterGraph = filters.join(',');

      const outExt = exportFormat === 'png' ? 'png' : 'jpg';
      const qualityArgs = exportFormat === 'jpeg'
        ? ['-q:v', String(Math.round(31 - (exportQuality * 29)))]
        : [];
      let runningId = 1;

      const readSegmentFrames = async ({ timeOffset, infoMap }) => {
        const frames = [];
        let idx = 1;
        while (true) {
          const filename = `out_${idx}.${outExt}`;
          let data;
          try {
            data = await ffmpeg.readFile(filename);
          } catch {
            break;
          }

          const mimeType = exportFormat === 'png' ? 'image/png' : 'image/jpeg';
          const blob = new Blob([data.buffer], { type: mimeType });
          const url = URL.createObjectURL(blob);
          const metadata = infoMap.get(idx - 1) || {};

          frames.push({
            id: runningId++,
            name: filename,
            url,
            blob,
            size: data.length,
            timestamp: typeof metadata.timestamp === 'number' && !isNaN(metadata.timestamp)
              ? timeOffset + metadata.timestamp
              : (timeOffset || idx - 1),
            resolution: metadata.resolution || (videoMeta ? videoMeta.resolution : 'Originale'),
            isDuplicate: false,
            duplicateOf: null,
            difference: 0
          });

          await ffmpeg.deleteFile(filename);
          idx++;
        }
        return frames;
      };

      let loadedFrames = [];

      if (!needsChunking) {
        const logStart = ffmpegLogsRef.current.length;
        const args = ['-i', 'input.mp4', '-vf', filterGraph, '-an', ...qualityArgs];
        if (extractionLimit > 0) {
          args.push('-vframes', String(extractionLimit));
        }
        args.push('-vsync', 'vfr', `out_%d.${outExt}`);

        await ffmpeg.exec(args);

        const infoMap = parseShowinfoLogs(ffmpegLogsRef.current.slice(logStart));
        updateStep('exec', 'completed');
        updateStep('read', 'active');
        loadedFrames = await readSegmentFrames({ timeOffset: 0, infoMap });
      } else {
        const totalSegs = duration !== null ? Math.max(1, Math.ceil(duration / segmentSeconds)) : null;
        let start = 0;
        let segIndex = 0;
        progressCtxRef.current = { type: 'chunk', done: 0, total: totalSegs || MAX_UNBOUNDED_SEGMENTS };

        while (true) {
          const remaining = duration !== null ? duration - start : Infinity;
          if (remaining <= 0.05) break;
          if (totalSegs === null && segIndex >= MAX_UNBOUNDED_SEGMENTS) break;
          if (extractionLimit > 0 && loadedFrames.length >= extractionLimit) break;

          const segDur = Math.min(segmentSeconds, remaining);
          setSegmentInfo({ index: segIndex + 1, total: totalSegs });

          const logStart = ffmpegLogsRef.current.length;
          const args = ['-ss', start.toFixed(3), '-i', 'input.mp4', '-t', segDur.toFixed(3)];
          if (extractionLimit > 0) {
            args.push('-vframes', String(extractionLimit - loadedFrames.length));
          }
          args.push('-vf', filterGraph, '-an', ...qualityArgs, '-vsync', 'vfr', `out_%d.${outExt}`);

          await ffmpeg.exec(args);

          const infoMap = parseShowinfoLogs(ffmpegLogsRef.current.slice(logStart));
          updateStep('read', 'active');
          const segFrames = await readSegmentFrames({ timeOffset: start, infoMap });
          loadedFrames = loadedFrames.concat(segFrames);

          segIndex += 1;
          start += segmentSeconds;
          progressCtxRef.current = { type: 'chunk', done: segIndex, total: totalSegs || MAX_UNBOUNDED_SEGMENTS };
          setProgress(totalSegs ? Math.round((segIndex / totalSegs) * 100) : 95);

          if (segFrames.length === 0) break;
          if (extractionLimit > 0 && loadedFrames.length >= extractionLimit) break;
        }

        progressCtxRef.current = { type: 'single', done: 0, total: 0 };
        updateStep('exec', 'completed');
      }
      
      try {
        await ffmpeg.deleteFile('input.mp4');
      } catch (e) {
        console.warn(e);
      }

      updateStep('read', 'completed');
      updateStep('dedup', 'active');

      if (loadedFrames.length === 0) {
        setErrorMessage("FFmpeg a terminé l'analyse mais aucune image nette n'a pu être extraite. Essayez le Mode Détaillé ou vérifiez que le fichier contient une piste vidéo exploitable.");
        setProcessing(false);
        updateStep('dedup', 'error');
        return;
      }

      setSegmentInfo(null);
      
      // Step 5: Compute visual similarity fingerprints + sharpness scores
      const framesWithAnalysis = [];
      for (let fIdx = 0; fIdx < loadedFrames.length; fIdx++) {
        const frame = loadedFrames[fIdx];
        setProgress(Math.round((fIdx / loadedFrames.length) * 100));
        const analysis = await analyzeFrameImage(frame.url);
        framesWithAnalysis.push({
          ...frame,
          fingerprint: analysis.fingerprint,
          sharpness: analysis.sharpness
        });
      }

      setRawFrames(framesWithAnalysis);
      updateStep('dedup', 'completed');
      setProcessing(false);
      
    } catch (err) {
      console.error(err);
      try {
        if (ffmpegInstance.current) {
          await ffmpegInstance.current.deleteFile('input.mp4');
        }
      } catch (cleanupErr) {
        console.warn(cleanupErr);
      }
      setErrorMessage("Une erreur est survenue lors du traitement de la vidéo : " + err.message);
      setProcessing(false);
      setStatusSteps(prev => prev.map(s => s.status === 'active' || s.status === 'pending' ? { ...s, status: 'error' } : s));
    }
  };

  // Perform Visual Deduplication dynamically based on threshold
  const processedFrames = useMemo(() => {
    if (!rawFrames || rawFrames.length === 0) return [];
    if (!dedupEnabled) {
      return rawFrames.map(f => ({ ...f, isDuplicate: false, duplicateOf: null }));
    }
    
    const updated = rawFrames.map(f => ({ ...f }));
    let currentParent = null;
    
    for (let i = 0; i < updated.length; i++) {
      const f = updated[i];
      if (i === 0) {
        f.isDuplicate = false;
        f.duplicateOf = null;
        f.difference = 0;
        currentParent = f;
      } else {
        const diff = calculateDifference(currentParent.fingerprint, f.fingerprint);
        f.difference = diff;
        if (diff < dedupThreshold) {
          f.isDuplicate = true;
          f.duplicateOf = currentParent.id;
        } else {
          f.isDuplicate = false;
          f.duplicateOf = null;
          currentParent = f;
        }
      }
    }
    
    // Sort logic
    if (sortOrder === 'size') {
      return updated.sort((a, b) => b.size - a.size);
    }
    if (sortOrder === 'sharpness') {
      return updated.sort((a, b) => (b.sharpness || 0) - (a.sharpness || 0));
    }
    return updated.sort((a, b) => a.timestamp - b.timestamp);
  }, [rawFrames, dedupEnabled, dedupThreshold, sortOrder]);

  // Compute stats
  const uniqueCount = useMemo(() => {
    return processedFrames.filter(f => !f.isDuplicate).length;
  }, [processedFrames]);

  const duplicateCount = useMemo(() => {
    return processedFrames.filter(f => f.isDuplicate).length;
  }, [processedFrames]);

  // Recommend best frame automatically
  const recommendedFrame = useMemo(() => {
    if (processedFrames.length === 0) return null;
    
    // Filter to unique frames
    const uniques = processedFrames.filter(f => !f.isDuplicate);
    if (uniques.length === 1) return uniques[0];
    
    // Group duplicates to find the longest static scene
    const groupSizes = {};
    processedFrames.forEach(f => {
      const parentId = f.isDuplicate ? f.duplicateOf : f.id;
      groupSizes[parentId] = (groupSizes[parentId] || 0) + 1;
    });
    
    let bestParentId = null;
    let maxCount = 0;
    for (const [id, count] of Object.entries(groupSizes)) {
      if (count > maxCount) {
        maxCount = count;
        bestParentId = parseInt(id, 10);
      }
    }
    
    // Recommending the parent of the longest static scene
    if (bestParentId !== null && maxCount > 1) {
      const frame = processedFrames.find(f => f.id === bestParentId);
      if (frame) return frame;
    }
    
    // Fallback: recommend the largest file size frame (usually highest detail)
    let bestFrame = processedFrames[0];
    for (const f of processedFrames) {
      if (f.size > bestFrame.size) {
        bestFrame = f;
      }
    }
    return bestFrame;
  }, [processedFrames]);

  const videoAspectRatio = videoMeta && videoMeta.height > 0
    ? `${videoMeta.width} / ${videoMeta.height}`
    : '16 / 9';

  // Automatically select recommended or first frame once extraction completes
  useEffect(() => {
    if (processedFrames.length > 0 && !selectedFrame) {
      setSelectedFrame(recommendedFrame || processedFrames[0]);
    }
  }, [processedFrames, selectedFrame, recommendedFrame]);

  // Handle individual frame download
  const handleDownload = (frame) => {
    if (!frame) return;
    const link = document.createElement('a');
    link.href = frame.url;
    
    const videoName = videoFile ? videoFile.name.replace(/\.[^/.]+$/, "") : "video";
    const tsStr = formatTimestamp(frame.timestamp).replace(/[:.]/g, "-");
    link.download = `FrameSnap_${videoName}_frame_${frame.id}_${tsStr}.${exportFormat}`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filtered gallery view
  const filteredFrames = useMemo(() => {
    if (galleryFilter === 'unique') {
      return processedFrames.filter(f => !f.isDuplicate);
    }
    if (galleryFilter === 'duplicates') {
      return processedFrames.filter(f => f.isDuplicate);
    }
    return processedFrames;
  }, [processedFrames, galleryFilter]);

  return (
    <>
      {/* Header */}
      <header className="app-header">
        <a href="/" className="brand">
          <span className="brand-logo">
            <Video size={24} strokeWidth={2.5} />
          </span>
          <span className="brand-name">FrameSnap</span>
        </a>
        <div className="header-actions">
          <button
            className="theme-toggle-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Changer le thème"
            title="Mode Clair / Sombre"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      {/* Browser Support Check */}
      {!browserSupported && (
        <div className="status-banner error">
          <AlertTriangle className="status-banner-icon" size={18} />
          <div className="status-banner-content">
            <div className="status-banner-title">Navigateur incompatible</div>
            <div className="status-banner-desc">
              Votre navigateur ne supporte pas WebAssembly. Veuillez utiliser une version récente de Google Chrome, Apple Safari, Mozilla Firefox ou Microsoft Edge.
            </div>
          </div>
        </div>
      )}

      {/* Error Message Box */}
      {errorMessage && (
        <div className="status-banner error animate-fade-in">
          <AlertTriangle className="status-banner-icon" size={18} />
          <div className="status-banner-content">
            <div className="status-banner-title">Une erreur est survenue</div>
            <div className="status-banner-desc">{errorMessage}</div>
          </div>
        </div>
      )}

      <main className="app-grid">
        {/* Left Column - Controls & Configuration */}
        <section className="left-column" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* File Picker / Preview Panel */}
          <div className="panel">
            <div className="panel-title">
              <FileVideo size={18} />
              Vidéo Source
            </div>
            
            {!videoFile ? (
              <div
                className={`drop-zone ${dragActive ? 'drag-active' : ''}`}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
              >
                <input
                  type="file"
                  className="file-input"
                  accept="video/*"
                  onChange={(e) => handleVideoSelect(e.target.files[0])}
                  disabled={processing}
                />
                <Video className="drop-zone-icon" size={32} />
                <div className="drop-zone-text">Déposez votre vidéo ici</div>
                <div className="drop-zone-subtext">ou cliquez pour parcourir vos fichiers</div>
              </div>
            ) : (
              <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="video-preview-card" style={{ aspectRatio: videoAspectRatio }}>
                  <video src={videoUrl} controls muted playsInline />
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', paddingBottom: '4px' }}>
                    <span style={{ fontWeight: '600' }}>Nom :</span>
                    <span className="form-label-badge" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '180px' }} title={videoFile.name}>{videoFile.name}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', paddingBottom: '4px' }}>
                    <span style={{ fontWeight: '600' }}>Poids :</span>
                    <span>{formatBytes(videoFile.size)}</span>
                  </div>
                  {videoMeta && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', paddingBottom: '4px' }}>
                        <span style={{ fontWeight: '600' }}>Résolution :</span>
                        <span>{videoMeta.resolution}</span>
                      </div>
                      {videoFps !== null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', paddingBottom: '4px' }}>
                          <span style={{ fontWeight: '600' }}>Cadence :</span>
                          <span>{videoFps.toFixed(2)} fps</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', paddingBottom: '4px' }}>
                        <span style={{ fontWeight: '600' }}>Durée :</span>
                        <span>{videoMeta.duration.toFixed(2)} secondes</span>
                      </div>
                    </>
                  )}
                </div>

                {videoFile.size > 150 * 1024 * 1024 && (
                  <div className="status-banner warning" style={{ padding: '8px 12px', fontSize: '0.75rem' }}>
                    <AlertTriangle className="status-banner-icon" size={14} />
                    <div className="status-banner-content">
                      <div className="status-banner-title">Vidéo volumineuse</div>
                      <div className="status-banner-desc">FFmpeg.wasm pourrait saturer la mémoire. Privilégiez le <strong>Mode Rapide</strong> ou réduisez la limite d'images.</div>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={handleReset}
                    disabled={processing}
                  >
                    <Trash2 size={16} />
                    Changer
                  </button>
                  
                  {!rawFrames.length && !processing && (
                    <button
                      className="btn btn-primary"
                      onClick={handleExtract}
                      disabled={processing}
                    >
                      <Sparkles size={16} />
                      Extraire
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Extraction Mode Panel */}
          <div className="panel">
            <div className="panel-title">
              <Gauge size={18} />
              Mode d'extraction
            </div>
            <div className="mode-selector">
              <button
                type="button"
                className={`mode-card ${extractMode === 'fast' ? 'selected' : ''}`}
                onClick={() => setExtractMode('fast')}
                disabled={processing}
              >
                <Zap className="mode-card-icon" size={20} />
                <div>
                  <div className="mode-card-title">Rapide</div>
                  <div className="mode-card-desc">
                    Échantillonne environ 1 image par seconde et garde la plus nette par petits lots. Traitement en une passe sur les vidéos courtes.
                  </div>
                </div>
              </button>
              <button
                type="button"
                className={`mode-card ${extractMode === 'detailed' ? 'selected' : ''}`}
                onClick={() => setExtractMode('detailed')}
                disabled={processing}
              >
                <Crosshair className="mode-card-icon" size={20} />
                <div>
                  <div className="mode-card-title">Détaillé</div>
                  <div className="mode-card-desc">
                    Analyse environ {THUMBNAIL_WINDOW_S} secondes de vidéo par image retenue, adapté au framerate réel et traité par segments pour préserver la mémoire.
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Advanced Panel */}
          <div className="panel">
            <button
              className="btn btn-secondary"
              style={{ justifyContent: 'space-between', border: 'none', padding: '0', background: 'none' }}
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              <div className="panel-title" style={{ margin: '0' }}>
                <Settings size={18} />
                Réglages Avancés
              </div>
              {advancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {advancedOpen && (
              <div className="animate-fade-in" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                
                {/* Chunk size */}
                <div className="form-group">
                  <label className="form-label">
                    Taille des segments
                    <span className="form-label-badge">{segmentSeconds} s</span>
                  </label>
                  <input
                    type="range"
                    className="form-range"
                    min="5"
                    max="15"
                    step="1"
                    value={segmentSeconds}
                    onChange={(e) => setSegmentSeconds(Number(e.target.value))}
                    disabled={processing}
                  />
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Durée traitée par passe FFmpeg en Mode Détaillé (et sur les vidéos de plus de {FAST_CHUNK_THRESHOLD_S} secondes).
                  </div>
                </div>

                {/* Limit */}
                <div className="form-group">
                  <label className="form-label">
                    Limite d'images
                    <span className="form-label-badge">{extractionLimit === 0 ? 'Illimitée' : `${extractionLimit} max`}</span>
                  </label>
                  <input
                    type="range"
                    className="form-range"
                    min="0"
                    max="100"
                    step="5"
                    value={extractionLimit}
                    onChange={(e) => setExtractionLimit(Number(e.target.value))}
                    disabled={processing}
                  />
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    0 = extraire toutes les images détectées (lent sur longues vidéos).
                  </div>
                </div>

                {/* Scaling */}
                <div className="form-group">
                  <label className="form-label">
                    Résolution d'export
                    <span className="form-label-badge">{scaleResolution === 'original' ? '100%' : scaleResolution === 'half' ? '50%' : '25%'}</span>
                  </label>
                  <select
                    className="form-select"
                    value={scaleResolution}
                    onChange={(e) => setScaleResolution(e.target.value)}
                    disabled={processing}
                  >
                    <option value="original">Originale</option>
                    <option value="half">Réduite (50%)</option>
                    <option value="quarter">Réduite (25%)</option>
                  </select>
                </div>

                {/* Export Format */}
                <div className="form-group">
                  <label className="form-label">
                    Format d'image
                    <span className="form-label-badge">{exportFormat.toUpperCase()}</span>
                  </label>
                  <select
                    className="form-select"
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value)}
                    disabled={processing}
                  >
                    <option value="png">PNG (Sans perte)</option>
                    <option value="jpeg">JPEG (Compressé)</option>
                  </select>
                </div>

                {/* JPEG Quality */}
                {exportFormat === 'jpeg' && (
                  <div className="form-group">
                    <label className="form-label">
                      Qualité JPEG
                      <span className="form-label-badge">{Math.round(exportQuality * 100)}%</span>
                    </label>
                    <input
                      type="range"
                      className="form-range"
                      min="0.1"
                      max="1.0"
                      step="0.05"
                      value={exportQuality}
                      onChange={(e) => setExportQuality(Number(e.target.value))}
                      disabled={processing}
                    />
                  </div>
                )}

                {/* Deduplication Toggle */}
                <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                  <label className="form-checkbox-label">
                    <input
                      type="checkbox"
                      className="form-checkbox"
                      checked={dedupEnabled}
                      onChange={(e) => setDedupEnabled(e.target.checked)}
                    />
                    Déduplication visuelle
                  </label>
                </div>

                {/* Deduplication Threshold */}
                {dedupEnabled && (
                  <div className="form-group animate-fade-in">
                    <label className="form-label">
                      Sensibilité des doublons
                      <span className="form-label-badge">{(10 - dedupThreshold).toFixed(1)}/10</span>
                    </label>
                    <input
                      type="range"
                      className="form-range"
                      min="1.0"
                      max="15.0"
                      step="0.5"
                      value={dedupThreshold}
                      onChange={(e) => setDedupThreshold(Number(e.target.value))}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      <span>Strict (Sensible)</span>
                      <span>Tolérant</span>
                    </div>
                  </div>
                )}

                {/* Sorting */}
                <div className="form-group">
                  <label className="form-label">Trier la galerie</label>
                  <select
                    className="form-select"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                  >
                    <option value="chrono">Chronologique (Temps)</option>
                    <option value="size">Poids de l'image (Détails)</option>
                    <option value="sharpness">Netteté (Score d'analyse)</option>
                  </select>
                </div>

              </div>
            )}
          </div>

          {/* Explanatory Help Panel */}
          <div className="panel help-panel">
            <div className="panel-title" style={{ fontSize: '0.9rem' }}>
              <HelpCircle size={16} />
              Pourquoi ces images sont plus nettes ?
            </div>
            <div className="help-text">
              <p>
                Plutôt que de capturer une frame au hasard, <strong>FrameSnap</strong> utilise le filtre <code>thumbnail</code> de FFmpeg : il compare toutes les frames d'une fenêtre temporelle et ne conserve que la plus représentative, en privilégiant les zones nettes et détaillées (moins de flou de mouvement).
              </p>
              <p>
                Le <strong>Mode Rapide</strong> échantillonne à 1 fps puis compare par petits lots. Le <strong>Mode Détaillé</strong> adapte automatiquement la taille des lots au framerate réel de votre vidéo (détecté via FFmpeg) et traite le fichier par segments, avec purge de la mémoire virtuelle après chaque passe pour éviter tout plantage.
              </p>
              <p>
                <em>Traitement 100% local : aucun fichier n'est envoyé sur un serveur.</em>
              </p>
            </div>
          </div>

        </section>

        {/* Right Column - Gallery & Large Preview */}
        <section className="right-column" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* State 1: No file loaded */}
          {!videoFile && !processing && (
            <div className="panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '360px', textAlign: 'center', padding: '40px' }}>
              <div style={{ backgroundColor: 'var(--accent-glow)', padding: '16px', borderRadius: 'var(--radius-full)', color: 'var(--accent)', marginBottom: '16px', animation: 'pulse-glow 2s infinite' }}>
                <Video size={40} />
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '8px' }}>Prêt à capturer vos meilleures images</h2>
              <p style={{ color: 'var(--text-secondary)', maxWidth: '420px', fontSize: '0.9rem', marginBottom: '24px' }}>
                Importez une vidéo locale pour extraire automatiquement les images les plus nettes grâce au filtre thumbnail de FFmpeg WebAssembly, directement dans votre navigateur.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <CheckCircle2 size={14} className="text-success" style={{ color: 'var(--success)' }} /> 100% local
                <span>•</span>
                <CheckCircle2 size={14} className="text-success" style={{ color: 'var(--success)' }} /> Précision FFmpeg
                <span>•</span>
                <CheckCircle2 size={14} className="text-success" style={{ color: 'var(--success)' }} /> Mode PWA hors-ligne
              </div>
            </div>
          )}

          {/* State 2: Processing (Loading FFmpeg + Running command) */}
          {processing && (
            <div className="panel processing-container animate-fade-in">
              <div style={{ position: 'relative', width: '64px', height: '64px', display: 'flex', alignItems: 'center', justifyContents: 'center', marginBottom: '16px' }}>
                <Loader2 className="animate-spin" size={48} style={{ color: 'var(--accent)' }} />
              </div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '4px' }}>Extraction des images nettes en cours...</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                Cette opération s'exécute localement et peut prendre quelques secondes.
              </p>

              {segmentInfo && (
                <p className="animate-fade-in" style={{ color: 'var(--accent)', fontWeight: '700', fontSize: '0.9rem', margin: '8px 0 0' }}>
                  Segment {segmentInfo.index}{segmentInfo.total ? ` / ${segmentInfo.total}` : ''}
                </p>
              )}
              
              <div className="progress-bar-container">
                <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
              </div>
              
              <div className="progress-steps">
                {statusSteps.map((step) => (
                  <div key={step.id} className={`progress-step ${step.status}`}>
                    <div className="progress-step-icon" />
                    <span>{step.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '0.75rem', fontWeight: 'bold' }}>
                      {step.status === 'completed' && '✓'}
                      {step.status === 'active' && `${progress}%`}
                      {step.status === 'pending' && 'En attente'}
                      {step.status === 'error' && 'Erreur'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* State 3: Extraction Completed & Results Available */}
          {rawFrames.length > 0 && !processing && (
            <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              
              {/* Large Preview & Downloader */}
              {selectedFrame && (
                <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="panel-title" style={{ justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <ImageIcon size={18} />
                      Aperçu de la Frame Sélectionnée
                    </div>
                    {recommendedFrame && selectedFrame.id === recommendedFrame.id && (
                      <span className="form-label-badge" style={{ backgroundColor: 'var(--accent)', color: '#fff', fontSize: '0.7rem' }}>
                        Recommandée (Image Principale)
                      </span>
                    )}
                  </div>
                  
                  <div className="preview-panel">
                    {/* Frame Viewport */}
                    <div className="preview-viewport" style={{ aspectRatio: videoAspectRatio, maxHeight: '70vh' }}>
                      <img src={selectedFrame.url} alt={`Frame ${selectedFrame.id}`} />
                    </div>
                    
                    {/* Metadata & Actions */}
                    <div className="preview-details">
                      <div className="metadata-list">
                        <div className="metadata-item">
                          <span className="metadata-label">Index</span>
                          <span className="metadata-value">#{selectedFrame.id}</span>
                        </div>
                        <div className="metadata-item">
                          <span className="metadata-label">Position temporelle</span>
                          <span className="metadata-value">{formatTimestamp(selectedFrame.timestamp)}</span>
                        </div>
                        <div className="metadata-item">
                          <span className="metadata-label">Résolution</span>
                          <span className="metadata-value">{selectedFrame.resolution}</span>
                        </div>
                        <div className="metadata-item">
                          <span className="metadata-label">Poids exporté</span>
                          <span className="metadata-value">{formatBytes(selectedFrame.size)}</span>
                        </div>
                        <div className="metadata-item">
                          <span className="metadata-label">Score de netteté</span>
                          <span className="metadata-value">{Math.round(selectedFrame.sharpness || 0)}</span>
                        </div>
                        {selectedFrame.isDuplicate && (
                          <div className="metadata-item" style={{ borderBottom: 'none' }}>
                            <span className="metadata-label" style={{ color: 'var(--warning)' }}>Similaire à</span>
                            <span className="metadata-value" style={{ color: 'var(--warning)' }}>Frame #{selectedFrame.duplicateOf}</span>
                          </div>
                        )}
                      </div>
                      
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <button
                          className="btn btn-primary"
                          onClick={() => handleDownload(selectedFrame)}
                        >
                          <Download size={16} />
                          Télécharger en {exportFormat.toUpperCase()}
                        </button>
                        <a
                          className="btn btn-secondary"
                          href={selectedFrame.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink size={16} />
                          Plein écran
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Gallery Grid */}
              <div className="panel gallery-section">
                <div className="gallery-header">
                  <div className="panel-title" style={{ margin: '0' }}>
                    <Layers size={18} />
                    Galerie d'images nettes
                    <span className="gallery-stats">
                      ({uniqueCount} unique{uniqueCount > 1 ? 's' : ''} {dedupEnabled && `+ ${duplicateCount} doublon${duplicateCount > 1 ? 's' : ''}`})
                    </span>
                  </div>

                  {/* Filter Controls */}
                  {dedupEnabled && duplicateCount > 0 && (
                    <div style={{ display: 'flex', gap: '4px', backgroundColor: 'var(--bg)', padding: '2px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '0.75rem', border: 'none', backgroundColor: galleryFilter === 'all' ? 'var(--bg-panel)' : 'transparent' }}
                        onClick={() => setGalleryFilter('all')}
                      >
                        Toutes
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '0.75rem', border: 'none', backgroundColor: galleryFilter === 'unique' ? 'var(--bg-panel)' : 'transparent' }}
                        onClick={() => setGalleryFilter('unique')}
                      >
                        Uniques
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '0.75rem', border: 'none', backgroundColor: galleryFilter === 'duplicates' ? 'var(--bg-panel)' : 'transparent' }}
                        onClick={() => setGalleryFilter('duplicates')}
                      >
                        Doublons
                      </button>
                    </div>
                  )}
                </div>

                {filteredFrames.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    Aucune frame ne correspond au filtre sélectionné.
                  </div>
                ) : (
                  <div className="gallery-grid">
                    {filteredFrames.map((frame) => {
                      const isSelected = selectedFrame && selectedFrame.id === frame.id;
                      const isRec = recommendedFrame && frame.id === recommendedFrame.id;
                      
                      return (
                        <div
                          key={frame.id}
                          className={`gallery-card ${isSelected ? 'selected' : ''}`}
                          onClick={() => setSelectedFrame(frame)}
                        >
                          <img src={frame.url} className="gallery-card-img" alt={`Frame ${frame.id}`} />
                          <span className="gallery-card-badge">
                            {formatTimestamp(frame.timestamp)}
                          </span>
                          {isRec && (
                            <span className="gallery-card-rec-badge">
                              Rec.
                            </span>
                          )}
                          {frame.isDuplicate && (
                            <span className="gallery-card-dup-badge">
                              Dup.
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {/* Re-extract Button in Gallery */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                  <button
                    className="btn btn-secondary"
                    style={{ width: 'auto' }}
                    onClick={handleExtract}
                    disabled={processing}
                  >
                    <RefreshCw size={14} className={processing ? "animate-spin" : ""} />
                    Relancer l'extraction
                  </button>
                </div>
              </div>

            </div>
          )}

        </section>
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <p>© 2026 FrameSnap • Outil d'extraction professionnel d'images nettes, 100% localisé.</p>
        <p style={{ color: 'var(--text-muted)' }}>
          Propulsé par FFmpeg.wasm et WebAssembly dans le navigateur.
        </p>
      </footer>
    </>
  );
}

export default App;
