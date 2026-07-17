import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cors from 'cors';
import { ZipArchive } from 'archiver';

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());

// Configuration de Multer pour stocker la vidéo uploadée dans /tmp
const upload = multer({ dest: os.tmpdir() });

// Middleware de sécurité (Token)
const requireToken = (req, res, next) => {
  // Option pour désactiver l'authentification
  if (process.env.AUTH === 'non' || process.env.AUTH === 'false') {
    return next();
  }

  const secretToken = process.env.API_SECRET_TOKEN;
  if (secretToken) {
    const authHeader = req.headers.authorization || '';
    const providedToken = authHeader.replace('Bearer ', '').trim();
    if (providedToken !== secretToken) {
      return res.status(401).json({ error: 'Non autorisé. Jeton invalide.' });
    }
  }
  next();
};

// Route pour l'extraction vidéo
app.post('/api/extract', requireToken, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier vidéo fourni.' });
  }

  const inputPath = req.file.path;
  const mode = req.body.mode || 'best'; // 'best' (1 frame) ou 'gallery' (toutes les I-frames)
  
  // Paramètres passés par le front
  const method = req.body.method || 'combined'; // combined, fast, precise
  const limit = parseInt(req.body.limit) || 0;
  const scale = req.body.scale || 'original'; // original, half, quarter
  const format = req.body.format || 'jpeg'; // png, jpeg
  const quality = parseFloat(req.body.quality) || 0.85;

  const uniqueId = Date.now() + '-' + Math.round(Math.random() * 10000);
  
  try {
    if (mode === 'gallery') {
      // Mode GALERIE : Extraire toutes les frames demandées et les renvoyer dans un ZIP
      const outputDir = path.join(os.tmpdir(), `frames-${uniqueId}`);
      await fs.promises.mkdir(outputDir);
      
      const outExt = format === 'png' ? 'png' : 'jpg';
      
      await new Promise((resolve, reject) => {
        let command = ffmpeg(inputPath);
        
        const filters = [];
        if (method === 'precise' || method === 'combined') {
          filters.push("select='eq(pict_type,I)'");
        }
        if (scale === 'half') {
          filters.push("scale=iw/2:-2");
        } else if (scale === 'quarter') {
          filters.push("scale=iw/4:-2");
        }
        
        if (method === 'fast' || method === 'combined') {
          command.inputOptions(['-skip_frame', 'nokey']);
        }
        
        if (filters.length > 0) {
          command.outputOptions(['-vf', filters.join(',')]);
        }
        
        command.outputOptions(['-an']);
        
        if (limit > 0) {
          command.outputOptions(['-vframes', String(limit)]);
        }
        
        command.outputOptions(['-vsync', 'vfr']);
        
        if (format === 'jpeg') {
          const qscale = Math.round(31 - (quality * 29));
          command.outputOptions(['-q:v', String(qscale)]);
        }
        
        command.output(`${outputDir}/out_%d.${outExt}`)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      // Créer l'archive ZIP
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="frames-${uniqueId}.zip"`);
      
      const archive = new ZipArchive({ zlib: { level: 5 } });
      archive.on('error', function(err) {
        throw err;
      });
      
      archive.pipe(res);
      archive.directory(outputDir, false);
      
      // On s'assure que le nettoyage se fait après la fin du flux
      archive.on('finish', () => {
        fs.promises.unlink(inputPath).catch(() => {});
        fs.rm(outputDir, { recursive: true, force: true }, () => {});
      });
      
      await archive.finalize();

    } else {
      // Mode BEST : Extraire une seule image
      const outputPath = path.join(os.tmpdir(), `output-${uniqueId}.jpg`);
      
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .screenshots({
            count: 1,
            timestamps: ['20%'],
            folder: os.tmpdir(),
            filename: `output-${uniqueId}.jpg`,
            size: '100%'
          });
      });

      const imageBuffer = await fs.promises.readFile(outputPath);

      await fs.promises.unlink(inputPath).catch(() => {});
      await fs.promises.unlink(outputPath).catch(() => {});

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Disposition', 'inline; filename="extracted-frame.jpg"');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(imageBuffer);
    }
    
  } catch (error) {
    console.error('Erreur durant l\'extraction:', error);
    await fs.promises.unlink(inputPath).catch(() => {});
    // Tenter de supprimer le dossier de sortie s'il existe
    fs.rm(path.join(os.tmpdir(), `frames-${uniqueId}`), { recursive: true, force: true }, () => {});
    return res.status(500).json({ error: 'Erreur lors du traitement de la vidéo.' });
  }
});

// Route de base (Healthcheck)
app.get('/', (req, res) => {
  res.send('FrameSnap API est en ligne.');
});

// Démarrer le serveur
app.listen(port, () => {
  console.log(`Serveur en écoute sur le port ${port}`);
});
