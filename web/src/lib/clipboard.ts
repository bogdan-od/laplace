import { toast } from "sonner";

/** Puts the text on the clipboard and says so; when the browser refuses, says that too. */
export async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Не вдалося скопіювати. Виділіть текст і скопіюйте вручну.");
  }
}
