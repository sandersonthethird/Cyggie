import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'

let tray: Tray | null = null

export function createTray(mainWindow: BrowserWindow): Tray {
  // Use a simple 16x16 template image for macOS menu bar
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)

  tray.setToolTip('GORP')
  updateTrayMenu(mainWindow, false)

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus()
    } else {
      mainWindow.show()
    }
  })

  return tray
}

export function updateTrayMenu(mainWindow: BrowserWindow, isRecording: boolean): void {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isRecording ? '● Recording...' : 'GORP',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => mainWindow.show()
    },
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      click: () => {
        mainWindow.webContents.send(
          isRecording ? 'recording:stop-from-tray' : 'recording:start-from-tray'
        )
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.setTitle(isRecording ? '●' : '')
}

export function getTray(): Tray | null {
  return tray
}
