Placeholder for icons.

## Windows build (from Mac)

If you build the Windows installer on a Mac (especially Apple Silicon), the default would be **ARM64**, which can install on a Windows laptop but leave the program folder empty (only uninstaller) and break shortcuts.

The project is configured to build **x64** Windows installers so they work on standard Windows PCs:

- `npm run build:win` uses `--x64` and `win.target` with `arch: ["x64"]`.
- Put `icon.ico` here for the Windows app icon (see .gitignore; add your own icon file).

## Replacing the VPS download (group-iq.com)

After building the Windows installer (`npm run build:win`), upload it so the download page serves the new build:

```bash
./scripts/upload-windows-build-to-vps.sh
```

This uploads `dist/GroupIQ Setup 1.0.0.exe` to the VPS at `/var/www/admin-panel/downloads/` (and as `GroupIQ-Setup-latest.exe`). Ensure nginx on the VPS has the `/downloads/` location (see `admin-panel/nginx.conf`). Download URL: `https://group-iq.com/downloads/GroupIQ-Setup-1.0.0.exe` or `.../GroupIQ-Setup-latest.exe`.
