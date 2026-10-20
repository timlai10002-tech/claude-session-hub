# Claude Sessions — Chrome 側邊面板

在 Chrome 右側顯示這台 Mac 上所有 Claude Code session 的狀態：

- 哪些 session 在跑（綠）、在等你回應（黃）、閒置多久
- 每個 session 的 context 用量、最近每次 prompt 的增量、prompt cache 剩餘時間
- 正在做什麼（目前的 todo 或最後一個工具呼叫）、todo 進度
- VS Code 視窗的 CPU / 記憶體 / GPU
- 工具列徽章：等你回應的數量（黃）或執行中的數量（綠）

資料只在你自己的電腦上：擴充只連 `127.0.0.1:8787`，不會傳到任何地方。

## 需求

- macOS
- Python 3（終端機輸入 `python3 --version` 確認；沒有的話執行 `xcode-select --install`）
- Chrome
- Claude Code（要有 session 才有東西可看）

## 安裝

1. 解壓縮後，在終端機執行：
   ```bash
   bash install.sh
   ```
   這會把本機小伺服器裝到 `~/Library/Application Support/claude-sessions/`，並設成每次登入自動啟動。
2. Chrome 打開 `chrome://extensions`，開啟右上角「開發人員模式」，按「載入未封裝項目」，選這個資料夾裡的 `extension`。
3. 在工具列拼圖圖示裡把「Claude Sessions」釘選出來，點它就會打開右側面板。

## 選用：點擊跳到 VS Code terminal

面板上點 session 名稱可以切到它所在的 VS Code 視窗和 terminal，`✕ close` 可以關閉那個 VS Code 視窗。這需要另外裝一個 VS Code 擴充：

```bash
code --install-extension vscode-extension/claude-terminal-focus.vsix
```

裝完後在每個已開啟的 VS Code 視窗執行一次 `Developer: Reload Window`。沒裝也能看狀態，只是不能跳轉和關閉。

## 移除

```bash
bash uninstall.sh
```

再到 `chrome://extensions` 移除擴充。

## 疑難排解

- **面板顯示「本機伺服器沒有在跑」**：重新執行 `bash install.sh`，錯誤會寫在 `~/Library/Application Support/claude-sessions/server.log`。
- **8787 埠被佔用**：目前埠號固定是 8787，請先關掉佔用它的程式。
- 用量限制（5h / 7d）那一行只有在 Claude Code 裡裝了 session-progress plugin 時才會出現。
