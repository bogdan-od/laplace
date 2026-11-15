import { useEffect, useState } from "react";
import { ClassPage } from "../mock/ClassPage";
import { Shell } from "../mock/Shell";
import { StudentPage } from "../mock/StudentPage";

// The design mock (web/src/mock), kept as a visual reference at /dev/mock.
function readHash(): string {
  return location.hash.slice(1);
}

export function MockPage() {
  const [route, setRoute] = useState(readHash);

  useEffect(() => {
    const onHash = () => {
      setRoute(readHash());
      document.querySelector("main")?.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <Shell kind="work">
      {route.startsWith("s/") ? (
        <StudentPage id={route.slice(2)} />
      ) : (
        <ClassPage view={route === "tiles" ? "tiles" : "table"} />
      )}
    </Shell>
  );
}
