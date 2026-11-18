// Shared Electron/db mocks for main.handlers.*.test.ts — import this module first.
import { vi } from 'vitest';

/** Mutable userData path for app.getPath — set in beforeEach of each suite. */
export const harnessPaths = { userData: '' as string };

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    disableHardwareAcceleration: vi.fn(),
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    once: vi.fn(),
    getPath: (name: string) => {
      if (name === 'home') return '/tmp';
      if (harnessPaths.userData && (name === 'userData' || name === 'appData')) {
        return harnessPaths.userData;
      }
      return `/tmp/mythos-harness-${name}`;
    },
    getAppPath: () => harnessPaths.userData || '/tmp/mythos-harness-app',
    getVersion: () => '0.0.0-test',
    getName: () => 'Mythos Writer',
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    exit: vi.fn(),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
  dialog: {
    showErrorBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
  },
  shell: { openExternal: vi.fn(), trashItem: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
}));

vi.mock('./jobs/jobWorker?nodeWorker', () => ({
  default: () => ({ postMessage() {}, terminate() {}, on() {}, once() {} }),
}));