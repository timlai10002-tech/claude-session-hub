"""Build dist/claude-sessions-chrome.zip: the Chrome extension plus a standalone local server.

The server files are copied from this plugin (web/, hooks/), so the bundle never drifts from it.
Run: python3 -I chrome-extension/make_bundle.py
"""
import os, shutil, sys, tempfile, zipfile

EXT = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(EXT)
DIST = os.path.join(PLUGIN, "dist")
NAME = "claude-sessions-chrome"

EXTENSION_FILES = ["manifest.json", "background.js", "panel.html", "panel.js", "icon16.png", "icon48.png", "icon128.png"]
SERVER_FILES = [("web", "server.py"), ("web", "index.html"), ("web", "acp.py"), ("web", "acp.html"), ("hooks", "scan.py"), ("hooks", "vscode.py")]

with tempfile.TemporaryDirectory() as tmp:
    root = os.path.join(tmp, NAME)
    os.makedirs(os.path.join(root, "extension"))
    os.makedirs(os.path.join(root, "server"))
    os.makedirs(os.path.join(root, "vscode-extension"))
    for f in EXTENSION_FILES:
        shutil.copy2(os.path.join(EXT, f), os.path.join(root, "extension", f))
    for d, f in SERVER_FILES:
        shutil.copy2(os.path.join(PLUGIN, d, f), os.path.join(root, "server", f))
    for f in ("install.sh", "uninstall.sh", "README.md"):
        shutil.copy2(os.path.join(EXT, "bundle", f), os.path.join(root, f))
    vsix = sorted(f for f in os.listdir(os.path.join(PLUGIN, "vscode-extension")) if f.endswith(".vsix"))
    if vsix:
        shutil.copy2(os.path.join(PLUGIN, "vscode-extension", vsix[-1]), os.path.join(root, "vscode-extension", "claude-terminal-focus.vsix"))

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"{NAME}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(root):
            for f in files:
                full = os.path.join(base, f)
                info = zipfile.ZipInfo.from_file(full, os.path.relpath(full, tmp))
                with open(full, "rb") as fh:
                    z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
print(out)
