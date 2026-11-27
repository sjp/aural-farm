/** How long the file's object URL is kept, so the browser has time to start the download. */
const REVOKE_MS = 10_000;

/** Hands the user `blob` as a file to save, named `fileName`, through a `blob:` link. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_MS);
}

/** Hands the user `text` as a file to save, named `fileName`. */
export function downloadText(fileName: string, text: string, type = "application/json"): void {
  downloadBlob(fileName, new Blob([text], { type }));
}
