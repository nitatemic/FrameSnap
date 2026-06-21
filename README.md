# 🎥 FrameSnap

> **Extracteur de véritables I-frames (keyframes) local, ultra-précis et performant, propulsé par FFmpeg en WebAssembly directement dans votre navigateur.**

[![Vite](https://img.shields.io/badge/Vite-8.x-purple?style=flat-square&logo=vite)](https://vite.dev/)
[![React](https://img.shields.io/badge/React-19.x-blue?style=flat-square&logo=react)](https://react.dev/)
[![FFmpeg.wasm](https://img.shields.io/badge/FFmpeg-WASM-orange?style=flat-square&logo=ffmpeg)](https://ffmpeg.org/)
[![PWA](https://img.shields.io/badge/PWA-Installable-green?style=flat-square)](https://web.dev/progressive-web-apps/)
[![License](https://img.shields.io/badge/License-MIT-black?style=flat-square)](LICENSE)

---

## 📖 À propos

**FrameSnap** est une application web moderne de traitement vidéo côté client conçue pour extraire les **vraies trames clés (I-frames / keyframes)** de fichiers vidéo sans jamais les uploader sur un serveur externe. 

Contrairement aux outils de capture HTML5 classiques qui se contentent de capturer une image décodée à un instant donné (souvent sujette à du flou de mouvement ou des approximations temporelles), FrameSnap interroge la structure physique du codec vidéo à l'aide de **FFmpeg exécuté dans le navigateur via WebAssembly**.

Il a été développé avec une attention rigoureuse apportée aux détails : esthétique haut de gamme, mode sombre natif, déduplication intelligente et ergonomie pensée pour l'usage mobile (PWA).

---

## ✨ Fonctionnalités clés

* **Extraction physique avec FFmpeg.wasm** : Écriture de la vidéo dans un système de fichiers virtuel WebAssembly, décodage précis, extraction native des I-frames et suppression automatique des fichiers temporaires pour économiser la mémoire.
* **Extraction des métadonnées originales** : Analyse en temps réel des logs FFmpeg via le filtre `showinfo` pour extraire les timestamps exacts (`pts_time`), la résolution originale et la position dans le flux de données.
* **Déduplication visuelle intelligente** : 
  * Analyse de similarité instantanée en générant une empreinte couleur RGB de 16x16 sur canvas.
  * Calcul de la distance RMS (Root Mean Square) en millisecondes pour repérer les doublons.
  * Masquage ou regroupement dynamique des frames redondantes à l'aide d'un curseur de sensibilité ajustable.
* **Recommandation intelligente de frame** : Idéal pour les vidéos de type Story Instagram ou statuts sociaux (image fixe + musique). L'application identifie automatiquement la première frame de la plus longue portion statique de la vidéo et la recommande avec un badge.
* **Panneau de configuration avancé** :
  * Trois méthodes d'extraction : *Combinée* (rapide et précise), *Ultra Rapide* (skip_frame nokey), *Précise* (select pict_type).
  * Limiteur de trames pour les longues vidéos.
  * Choix du format de sortie (PNG sans perte / JPEG compressé) et curseur de qualité JPEG.
  * Mise à l'échelle de l'export (100% / 50% / 25%) garantissant des dimensions paires compatibles.
* **PWA Installable & Hors-ligne** : Support complet pour l'écran d'accueil mobile, gestion des zones de sécurité tactiles, thèmes clair et sombre synchronisés, et stockage de cache local (Service Worker).

---

## 🛠️ Architecture technique

### 1. Logique d'extraction FFmpeg

L'application orchestre les appels WASM en assemblant dynamiquement la commande suivante selon les réglages choisis par l'utilisateur :

```bash
ffmpeg -skip_frame nokey -i input.mp4 -vf "select='eq(pict_type,I)',scale=iw/2:-2,showinfo" -an -vsync vfr out_%d.png
```

* `-skip_frame nokey` : Demande au décodeur d'ignorer les trames B et P dès la lecture du flux (gain de vitesse allant jusqu'à 50x).
* `select='eq(pict_type,I)'` : Conserve uniquement les images clés complètes de type I (Intra-coded).
* `scale=iw/2:-2` : Met à l'échelle la vidéo tout en conservant le ratio d'aspect d'origine et en forçant une hauteur paire (`-2`), évitant les erreurs de décodage FFmpeg.
* `showinfo` : Logue les informations de trame dans la console WASM (exploité par notre parser de logs).
* `-an` : Désactive le traitement audio pour accélérer le traitement.
* `-vsync vfr` : Utilise un framerate variable pour n'exporter que les images sélectionnées par le filtre.

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
