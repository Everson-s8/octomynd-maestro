/* Safe bridge exposed to the dashboard renderer. The renderer never receives
 * Electron's shell or ipcRenderer objects directly; it can only request that
 * the main process open a validated external URL. */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("maestroDesktop", {
  openExternal: (url) => ipcRenderer.invoke("maestro:open-external", url),
  onUpdateStatus: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("maestro:update-status", listener);
    return () => ipcRenderer.removeListener("maestro:update-status", listener);
  }
});
