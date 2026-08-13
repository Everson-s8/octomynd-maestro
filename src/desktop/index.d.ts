export function getDesktopWindowOptions(): {
  width: number;
  height: number;
  title: string;
  backgroundColor: string;
  show: boolean;
  webPreferences: {
    nodeIntegration: boolean;
    contextIsolation: boolean;
  };
};

export function resolveDesktopLoadUrl(apiHost?: string, apiPort?: string): string;
