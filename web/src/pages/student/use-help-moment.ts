import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { HelpRequest } from "@shared/api";
import { describeError } from "@/lib/api";
import { helpMomentHref } from "@/machine/help-moment";

/** Opens the player at the moment of a help request; `reply` offers the answer there. `opening` is the id of the request being opened. */
export function useHelpMoment() {
  const navigate = useNavigate();
  const [opening, setOpening] = useState<number | null>(null);

  const open = async (help: Pick<HelpRequest, "id" | "branch_id" | "event_count">, reply: boolean) => {
    setOpening(help.id);
    try {
      void navigate(await helpMomentHref(help, reply));
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setOpening(null);
    }
  };

  return { opening, open };
}
