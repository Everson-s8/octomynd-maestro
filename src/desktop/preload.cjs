/* Safe bridge exposed to the dashboard renderer. The renderer never receives
 * Electron's shell or ipcRenderer objects directly; it can only request that
 * the main process open a validated external URL. */

const { contextBridge, ipcRenderer } = require("electron");

let latestUpdateStatus = null;
const updateListeners = new Set();
ipcRenderer.on("maestro:update-status", (_event, status) => {
  latestUpdateStatus = status;
  for (const listener of updateListeners) listener(status);
});

contextBridge.exposeInMainWorld("maestroDesktop", {
  openExternal: (url) => ipcRenderer.invoke("maestro:open-external", url),
  installUpdate: () => ipcRenderer.invoke("maestro:install-update"),
  onUpdateStatus: (callback) => {
    if (typeof callback !== "function") return () => {};
    updateListeners.add(callback);
    if (latestUpdateStatus) callback(latestUpdateStatus);
    return () => updateListeners.delete(callback);
  }
});
