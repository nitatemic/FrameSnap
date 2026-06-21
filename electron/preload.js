import { contextBridge } from 'electron'

// Exposer une API basique au processus de rendu (navigateur) si besoin.
contextBridge.exposeInMainWorld('electronAPI', {
  // on pourra ajouter des fonctions ici (ex: lire un fichier natif)
})
