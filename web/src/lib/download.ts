/** Hands bytes to the browser as a file download. */
export function downloadBytes(name: string, bytes: Uint8Array, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
