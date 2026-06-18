export {};
declare global {
  interface Window {
    verne: {
      invoke<T>(method: string, params?: unknown): Promise<T>;
      listen(event: string, handler: (payload: unknown) => void): () => void;
      assetUrl(path: string): string;
      filePathForFile(file: File): string;
    };
  }
}
