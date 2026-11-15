import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadBytes } from "@/lib/download";
import { hasNetFrames } from "@/machine/pcap";

export interface PcapButtonProps {
  /** Frames the file will hold; null while that is not known yet. */
  frames: number | null;
  build: () => Uint8Array | null;
  fileName: string;
  className?: string;
}

/** "Завантажити трафік (.pcap)": the frames that arrived at the machine; absent when there are none. */
export function PcapButton({ frames, build, fileName, className }: PcapButtonProps) {
  if (!hasNetFrames(frames)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className={className}
      data-testid="pcap"
      data-frames={frames}
      title="Кадри, що надійшли до машини"
      onClick={() => {
        const bytes = build();
        if (bytes !== null) downloadBytes(fileName, bytes, "application/vnd.tcpdump.pcap");
      }}
    >
      <Download /> Завантажити трафік (.pcap)
    </Button>
  );
}
