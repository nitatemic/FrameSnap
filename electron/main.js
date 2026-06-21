import { app, BrowserWindow, session, protocol, net } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// Doit être appelé avant que l'application ne soit prête pour définir app:// comme sécurisé
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    }
  }
])

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Variables injectées par vite-plugin-electron
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // ffmpeg a besoin d'être dans un contexte web sécurisé avec SharedArrayBuffer
    },
  })

  // Pour supporter ffmpeg.wasm, nous devons ajouter les headers COOP et COEP
  // afin d'activer SharedArrayBuffer sur toutes les requêtes de l'app.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    })
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // Intercepter le protocole personnalisé app:// pour lire les fichiers locaux depuis dist/
    // Cela permet d'avoir une "vraie" URL (app://localhost/) et donc d'activer SharedArrayBuffer
    // contrairement au protocole file:// qui limite les workers et WebAssembly.
    protocol.handle('app', async (request) => {
      const urlObj = new URL(request.url)
      let pathname = decodeURIComponent(urlObj.pathname)
      if (pathname === '/') {
        pathname = '/index.html'
      }
      
      const filePath = path.join(RENDERER_DIST, pathname)
      // On utilise net.fetch qui gère automatiquement les types MIME
      const response = await net.fetch(pathToFileURL(filePath).toString())
      
      // Injection manuelle des headers pour activer SharedArrayBuffer
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      })
    })
    
    win.loadURL('app://localhost/')
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)
