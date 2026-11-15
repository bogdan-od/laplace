import type { Submission } from "@shared/api";
import { formatClock } from "@/lib/format";
import { growthChart, type ChartBox } from "./submission-view";

const BOX: ChartBox = { width: 480, height: 130, padding: { left: 34, right: 12, top: 10, bottom: 22 } };
const LINE_COLORS = ["var(--primary)", "var(--status-work)", "var(--status-done)", "var(--status-stuck)"];

/** How the journal reached the server: one line per machine, events over server time. */
export function GrowthChartView({ growth }: { growth: Submission["growth"] }) {
  const chart = growthChart(growth, BOX);
  if (chart === null) {
    return (
      <p data-testid="growth-empty" className="text-[13px] text-muted-foreground">
        Немає даних про час надходження журналу
      </p>
    );
  }
  const { width, height, padding } = BOX;
  const baseline = height - padding.bottom;
  const several = chart.lines.length > 1;
  const chunks = chart.lines.reduce((sum, line) => sum + line.points.length, 0);
  return (
    <figure data-testid="growth-chart" data-chunks={chunks} className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Зростання журналу" className="w-full max-w-xl text-muted-foreground">
        <line x1={padding.left} y1={baseline} x2={width - padding.right} y2={baseline} stroke="currentColor" strokeOpacity={0.4} />
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={baseline} stroke="currentColor" strokeOpacity={0.4} />
        <text x={padding.left - 4} y={padding.top + 4} textAnchor="end" fontSize={10} fill="currentColor">
          {chart.maxEvents}
        </text>
        <text x={padding.left - 4} y={baseline} textAnchor="end" fontSize={10} fill="currentColor">
          0
        </text>
        <text x={padding.left} y={height - 6} fontSize={10} fill="currentColor">
          {formatClock(chart.from)}
        </text>
        <text x={width - padding.right} y={height - 6} textAnchor="end" fontSize={10} fill="currentColor">
          {formatClock(chart.to)}
        </text>
        {chart.lines.map((line, index) => {
          const color = LINE_COLORS[index % LINE_COLORS.length];
          return (
            <g key={line.node} data-node={line.node} stroke={color} fill={color}>
              <path d={line.path} fill="none" strokeWidth={1.5} />
              {line.points.map((point) => (
                <circle key={`${point.at}/${point.events}`} cx={point.x} cy={point.y} r={2.5} stroke="none">
                  <title>{`${formatClock(point.at)}: ${point.events}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 text-[12px] text-muted-foreground">
        <span>Подій у журналі за часом сервера</span>
        {several &&
          chart.lines.map((line, index) => (
            <span key={line.node} className="font-mono" style={{ color: LINE_COLORS[index % LINE_COLORS.length] }}>
              {line.node}
            </span>
          ))}
      </figcaption>
    </figure>
  );
}
