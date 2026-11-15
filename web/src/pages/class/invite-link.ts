import { toast } from "sonner";

export function inviteLink(code: string): string {
  return `${globalThis.location.origin}/join/${code}`;
}

export async function copyInviteLink(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink(code));
    toast.success("Посилання скопійовано");
  } catch {
    toast.error("Не вдалося скопіювати. Виділіть посилання в діалозі з QR-кодом і скопіюйте вручну.");
  }
}
