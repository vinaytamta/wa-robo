# Windows build workflow

Build unpacked first, test it, then create the installer.

## Prerequisites

- Node.js 18+ installed
- `npm install` already run in the project
- **Close GroupIQ** if it is running (so `dist` can be cleaned/rebuilt, and so the installer build can overwrite files)

## Step 1: Build unpacked (no installer)

Produces `dist/win-unpacked/` with `GroupIQ.exe` and all app files. No NSIS/portable yet.

```powershell
$env:USE_HARD_LINKS = "false"
npm run build:win:unpacked
```

## Step 2: Test the unpacked app

Run the unpacked exe to verify it starts and works:

```powershell
.\dist\win-unpacked\GroupIQ.exe
```

Or use the test script (launches the exe):

```powershell
npm run test:unpacked
```

**Check:**

- App window opens
- Login or main UI loads
- No console errors (if you run from terminal)
- WhatsApp connect / groups flow works if you use it

## Step 3: Build installer (after testing)

Only run this after you’re happy with the unpacked build.

```powershell
$env:USE_HARD_LINKS = "false"
npm run build:win:installer
```

**Output:**

- `dist/GroupIQ Setup 1.0.0.exe` – NSIS installer
- `dist/GroupIQ 1.0.0.exe` – portable executable (no install)

## One-shot (unpacked → test → installer)

```powershell
$env:USE_HARD_LINKS = "false"

# 1. Unpacked build
npm run build:win:unpacked

# 2. Test (run GroupIQ, then close it)
.\dist\win-unpacked\GroupIQ.exe

# 3. Installer (after closing the app)
npm run build:win:installer
```

## Notes

- `USE_HARD_LINKS=false` is required on OneDrive/synced folders.
- Code signing is disabled (`signAndEditExecutable: false`); installers are unsigned. Users may see SmartScreen; they can choose “Run anyway”.
- Icons: `build/icon.ico` is referenced; if missing, the default Electron icon is used.
