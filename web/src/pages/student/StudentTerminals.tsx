import { useCallback, useState } from "react";
import type { SerialPort } from "@shared/ws";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { SerialTerminal } from "@/machine/SerialTerminal";
import type { SerialListener } from "@/machine/serial-history";
import type { TeacherRoom } from "@/machine/teacher-room";

export interface StudentTerminalsProps {
  room: TeacherRoom;
  userId: number;
  /** The machine the big terminal shows. */
  machine: string;
}

/**
 * The student's console (port 0, read-only until the teacher takes the input over) and the hidden terminal (port 2,
 * a root shell the student does not see; typing always goes there).
 */
export function StudentTerminals({ room, userId, machine }: StudentTerminalsProps) {
  const [port, setPort] = useState<SerialPort>(0);
  const [intercept, setIntercept] = useState(false);
  const history = useCallback(() => room.serialHistory(userId, machine, port), [room, userId, machine, port]);
  const subscribe = useCallback((listener: SerialListener) => room.onSerial(userId, machine, port, listener), [room, userId, machine, port]);
  const type = useCallback((data: string) => void room.sendInput(userId, data, { port, machine }), [room, userId, machine, port]);
  const typing = port === 2 || intercept;

  return (
    <section data-testid="terminals" className="flex w-min max-w-full flex-col gap-2">
      <Tabs value={String(port)} onValueChange={(value) => setPort(value === "2" ? 2 : 0)}>
        <TabsList variant="line" className="h-auto justify-start">
          <TabsTrigger value="0" data-testid="tab-main" className="flex-none px-3">
            Термінал студента
          </TabsTrigger>
          <TabsTrigger value="2" data-testid="tab-hidden" className="flex-none px-3">
            Прихований термінал
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {port === 0 ? (
        <div className="flex min-h-8 items-center gap-3 text-sm">
          {intercept ? (
            <>
              <span data-testid="intercept-note" className="font-medium text-primary">
                Ви вводите в термінал студента
              </span>
              <Button size="sm" variant="outline" data-testid="release" onClick={() => setIntercept(false)}>
                Повернути керування
              </Button>
            </>
          ) : (
            <>
              <span className="text-muted-foreground">Тільки перегляд</span>
              <Button size="sm" variant="outline" data-testid="intercept" onClick={() => setIntercept(true)}>
                Перехопити ввід
              </Button>
            </>
          )}
        </div>
      ) : (
        <p data-testid="hidden-note" className="flex min-h-8 items-center text-sm text-muted-foreground">
          Студент його не бачить
        </p>
      )}
      <SerialTerminal
        key={`${machine}/${port}`}
        data-testid="teacher-terminal"
        data-port={port}
        data-node={machine}
        data-typing={typing}
        className={cn(typing && port === 0 && "ring-2 ring-primary")}
        history={history}
        subscribe={subscribe}
        onType={typing ? type : undefined}
      />
    </section>
  );
}
