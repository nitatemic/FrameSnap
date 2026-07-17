# Utiliser l'image Node.js slim (légère) basée sur Debian
FROM node:20-slim

# Mettre à jour les paquets et installer le vrai binaire système FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Définir le dossier de travail dans le conteneur
WORKDIR /app

# Copier le package.json et installer les dépendances
COPY package*.json ./
RUN npm install --production

# Copier le reste des fichiers du serveur
COPY . .

# Option d'authentification (mettre AUTH=non pour désactiver)
ENV AUTH=""

# Scaleway Serverless Containers écoute par défaut sur le port 8080
ENV PORT=8080
EXPOSE 8080

# Démarrer le serveur
CMD ["node", "index.js"]
