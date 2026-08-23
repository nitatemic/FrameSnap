# 🎥 FrameSnap

> **Extracteur d'images nettes local, ultra-précis et performant, propulsé par FFmpeg en WebAssembly directement dans votre navigateur.**

[![Vite](https://img.shields.io/badge/Vite-8.x-purple?style=flat-square&logo=vite)](https://vite.dev/)
[![React](https://img.shields.io/badge/React-19.x-blue?style=flat-square&logo=react)](https://react.dev/)
[![FFmpeg.wasm](https://img.shields.io/badge/FFmpeg-WASM-orange?style=flat-square&logo=ffmpeg)](https://ffmpeg.org/)
[![PWA](https://img.shields.io/badge/PWA-Installable-green?style=flat-square)](https://web.dev/progressive-web-apps/)
[![License](https://img.shields.io/badge/License-MIT-black?style=flat-square)](LICENSE)

---

## 📖 À propos

**FrameSnap** est une application web moderne de traitement vidéo côté client conçue pour extraire automatiquement les **images les plus nettes** de fichiers vidéo sans jamais les uploader sur un serveur externe. 

Contrairement aux outils de capture HTML5 classiques qui se contentent de capturer une image décodée à un instant donné (souvent sujette à du flou de mouvement ou des approximations temporelles), FrameSnap s'appuie sur le filtre `thumbnail` de **FFmpeg exécuté dans le navigateur via WebAssembly** pour analyser chaque fenêtre temporelle et ne conserver que la frame la plus représentative.

Il a été développé avec une attention rigoureuse apportée aux détails : esthétique haut de gamme, mode sombre natif, déduplication intelligente et ergonomie pensée pour l'usage mobile (PWA).

---

## ✨ Fonctionnalités clés

* **Extraction par netteté avec FFmpeg.wasm** : Écriture de la vidéo dans un système de fichiers virtuel WebAssembly, sélection de la meilleure frame par lot via le filtre `thumbnail`, puis suppression automatique des fichiers temporaires pour économiser la mémoire.
* **Deux modes d'extraction** :
  * *Mode Rapide* : échantillonnage à 1 fps et comparaison par petits lots (`fps=1,thumbnail=2`), une seule passe sur les vidéos courtes (≤ 120 s).
  * *Mode Détaillé* : taille de lot adaptée au framerate réel détecté automatiquement, traitement segmenté avec purge mémoire après chaque segment.
* **Extraction des métadonnées originales** : Analyse en temps réel des logs FFmpeg via le filtre `showinfo` pour extraire les timestamps exacts (`pts_time`), la résolution originale et la position dans le flux de données.
* **Déduplication visuelle intelligente** : 
  * Analyse de similarité instantanée en générant une empreinte couleur RGB de 16x16 sur canvas.
  * Calcul de la distance RMS (Root Mean Square) en pourcentage pour repérer les doublons.
  * Masquage ou regroupement dynamique des frames redondantes à l'aide d'un curseur de sensibilité ajustable.
* **Score de netteté par image** : Chaque frame extraite est analysée (variance du filtre laplacien sur une copie en niveaux de gris) et reçoit un score consultable dans les métadonnées, utilisable comme critère de tri de la galerie.
* **Détection automatique du framerate** : La cadence réelle de la vidéo (24/25/30/60 fps…) est extraite des logs FFmpeg lors de la sonde initiale et affichée dans les métadonnées.
* **Recommandation intelligente de frame** : Idéal pour les vidéos de type Story Instagram ou statuts sociaux (image fixe + musique). L'application identifie automatiquement la première frame de la plus longue portion statique de la vidéo et la recommande avec un badge.
* **Panneau de configuration avancé** :
  * Choix du mode d'extraction (Rapide / Détaillé) et taille des segments réglable (5 à 15 s).
  * Limiteur d'images pour les longues vidéos.
  * Choix du format de sortie (PNG sans perte / JPEG compressé) et curseur de qualité JPEG.
  * Mise à l'échelle de l'export (100% / 50% / 25%) garantissant des dimensions paires compatibles.
* **PWA Installable & Hors-ligne** : Support complet pour l'écran d'accueil mobile, gestion des zones de sécurité tactiles, thèmes clair et sombre synchronisés, et stockage de cache local (Service Worker).

---

## 🛠️ Architecture technique

### 1. Logique d'extraction FFmpeg

Avant toute extraction, une passe de sonde (`ffmpeg -i input.mp4`, sans fichier de sortie) fait afficher à FFmpeg ses métadonnées de flux : le framerate réel et la durée sont extraits des logs.

Selon le mode choisi, l'application assemble dynamiquement l'une des commandes suivantes :

**Mode Rapide (vidéo ≤ 120 s, une seule passe) :**

```bash
ffmpeg -i input.mp4 -vf "fps=1,scale=iw/2:-2,thumbnail=2,showinfo" -an -vsync vfr out_%d.png
```

**Mode Détaillé (traitement segmenté, ici segment n° 3) :**

```bash
ffmpeg -ss 20.000 -t 10.000 -i input.mp4 -vf "scale=iw/2:-2,thumbnail=60,showinfo" -an -vsync vfr out_%d.png
```

* `fps=1` : normalise le flux à 1 image par seconde avant comparaison (le résultat est donc indépendant du framerate source).
* `thumbnail=N` : met en concurrence les N frames consécutives et ne garde que la plus représentative (la plus nette). En Mode Détaillé, N est calculé comme `fps × 2s` (borné entre 8 et 90) afin que la fenêtre d'analyse reste constante quelle que soit la cadence de la vidéo (24/25/30/60 fps).
* `-ss ... -t ...` : seek rapide (placé **avant** `-i`) et durée de segment ; la vidéo longue est découpée en segments traités en boucle.
* `scale=iw/2:-2` : Met à l'échelle la vidéo tout en conservant le ratio d'aspect d'origine et en forçant une hauteur paire (`-2`), évitant les erreurs de décodage FFmpeg.
* `showinfo` : Logue les informations de trame dans la console WASM (exploité par notre parser de logs, avec un offset temporel par segment puisque `-ss` réinitialise `pts_time`).
* `-an` / `-vsync vfr` : Désactive l'audio et n'exporte que les images sélectionnées par le filtre.

Après chaque segment, les images générées sont lues via `readFile`, converties en blobs, puis supprimées du système de fichiers virtuel via `deleteFile` pour plafonner la consommation RAM.

### 2. Algorithme de déduplication

Le calcul de similarité s'appuie sur la comparaison de tableaux d'octets `Uint8ClampedArray` issus d'un rendu Canvas miniature de `16x16` pixels :

$$\text{Distance} = \frac{1}{255} \sqrt{\frac{\sum_{i=1}^{N} (R_1^i - R_2^i)^2 + (G_1^i - G_2^i)^2 + (B_1^i - B_2^i)^2}{3 \times N}} \times 100$$

Cette approche permet de comparer instantanément des dizaines de frames en moins de 1ms, offrant une interactivité parfaite lors du glissement du curseur de sensibilité de déduplication.

---

## 🚀 Installation et exécution

### Prérequis

* **Node.js** (v20 ou supérieure recommandée)
* **npm** ou **yarn**

### 1. Cloner le projet et installer les dépendances

```bash
# Installer les modules
npm install
```

### 2. Lancer le serveur de développement

FrameSnap est disponible en deux versions : **Web** (classique) et **Bureau** (application native via Electron).

**Pour la version Web :**
```bash
npm run dev
```
L'application sera lancée localement sur [http://localhost:5173/](http://localhost:5173/).

**Pour la version Bureau :**
```bash
npm run dev:desktop
```
Le serveur web démarrera et la fenêtre native de l'application de bureau Electron s'ouvrira automatiquement.

### 3. Compiler pour la production

**Pour déployer le site web :**
```bash
npm run build
```
Les fichiers statiques seront générés dans le dossier `/dist`.

**Pour compiler l'application de bureau (Installateurs Mac, Windows et Linux) :**
```bash
npm run build:desktop
```
Les exécutables finaux (`.dmg`, `.exe`, `.deb`, etc.) seront générés dans le dossier `/release`. L'application embarque le navigateur Chromium pour garantir que WebAssembly et les en-têtes Cross-Origin nécessaires à `ffmpeg.wasm` soient parfaitement supportés.

---

## ⚠️ Notes importantes pour le déploiement

FFmpeg.wasm nécessite l'utilisation de `SharedArrayBuffer` sur certains navigateurs. Pour cette raison, les serveurs d'hébergement (Vercel, Netlify, GitHub Pages, Apache, etc.) doivent être configurés pour envoyer les en-têtes HTTP suivants :

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

*Remarque : En local, notre configuration Vite active automatiquement ces en-têtes.*

---

## 🛡️ Confidentialité et Sécurité

FrameSnap respecte entièrement votre vie privée. **Aucune donnée vidéo n'est transférée vers un serveur ou un service cloud**. Tout le décodage, l'analyse et la génération d'images sont effectués à 100 % dans le bac à sable (sandbox) WebAssembly de votre propre navigateur.

---

## 📄 Licence

Ce projet est sous licence MIT. Voir le fichier [LICENSE](LICENSE) pour plus de détails.
