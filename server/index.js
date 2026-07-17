import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';

const app = express();
const port = process.env.PORT || 8080;

// Configuration de Multer pour stocker la vidéo uploadée dans /tmp
const upload = multer({ dest: os.tmpdir() });

// Middleware de sécurité (Token)
const requireToken = (req, res, next) => {
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
  const uniqueId = Date.now() + '-' + Math.round(Math.random() * 10000);
  const outputPath = path.join(os.tmpdir(), `output-${uniqueId}.jpg`);

  try {
    // Extraire la première frame avec FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .screenshots({
          count: 1,
          timestamps: ['00:00:00.000'],
          folder: os.tmpdir(),
          filename: `output-${uniqueId}.jpg`,
          size: '100%' // Garder la résolution originale
        });
    });

    // Lire l'image extraite
    const imageBuffer = await fs.promises.readFile(outputPath);

    // Nettoyer les fichiers temporaires
    await fs.promises.unlink(inputPath).catch(() => {});
    await fs.promises.unlink(outputPath).catch(() => {});

    // Renvoyer l'image
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline; filename="extracted-frame.jpg"');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(imageBuffer);

  } catch (error) {
    console.error('Erreur durant l\'extraction:', error);
    
    // Nettoyage en cas d'erreur
    await fs.promises.unlink(inputPath).catch(() => {});
    await fs.promises.unlink(outputPath).catch(() => {});

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
