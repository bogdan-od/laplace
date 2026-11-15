import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Columns2 } from "lucide-react";
import { Link } from "react-router";
import { PcapButton } from "@/components/PcapButton";
import { Button } from "@/components/ui/button";
import { apiQuery } from "@/lib/query";
import { buildPcap, countNetFrames } from "@/machine/pcap";

export interface MachineActionsProps {
  submissionId: number;
  studentId: number;
  node: string;
  /** The library item the assignment was made from, when the teacher has a reference journal for this machine. */
  referenceItem: number | null;
}

/** Per machine of a submission: its traffic as a .pcap file and the comparison with the reference. */
export function MachineActions({ submissionId, studentId, node, referenceItem }: MachineActionsProps) {
  const journal = useQuery(apiQuery("GET /api/submissions/:id/journals/:node", { params: { id: submissionId, node } }));
  const frames = useMemo(() => (journal.data ? countNetFrames(journal.data, node) : null), [journal.data, node]);
  return (
    <div data-testid="machine-actions" data-node={node} className="flex flex-wrap items-center gap-2">
      {referenceItem !== null && (
        <Button asChild size="sm" variant="outline">
          <Link
            data-testid="compare-open"
            to={`/compare?a=submission-${submissionId}-${node}&b=item-${referenceItem}-${node}-reference`}
          >
            <Columns2 /> Порівняти з еталоном
          </Link>
        </Button>
      )}
      <PcapButton
        frames={frames}
        build={() => (journal.data ? buildPcap(journal.data, node) : null)}
        fileName={`${studentId}-${submissionId}-${node}.pcap`}
      />
    </div>
  );
}
