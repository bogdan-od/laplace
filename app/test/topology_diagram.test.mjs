import { test } from "node:test";
import assert from "node:assert/strict";
import { render_diagram } from "../ui/topology_diagram.mjs";

const DESC = {
    machines: [
        { id: "pc1", title: "Клієнт <1>", profile: "buildroot" },
        { id: "r1", title: "Роутер", profile: "alpine" },
        { id: "srv", title: "Сервер", profile: "buildroot" },
    ],
    switches: [{ id: "sw1" }, { id: "sw2" }],
    links: [
        { machine: "pc1", switch: "sw1", mode: "access", vlan: 10 },
        { machine: "r1", switch: "sw1", mode: "trunk", allowed: [10, 20] },
        { machine: "srv", switch: "sw2", mode: "access", vlan: 20 },
        { switch: "sw1", to: "sw2", mode: "trunk", allowed: [10, 20] },
        { uplink: "relay", switch: "sw2", mode: "access", vlan: 30 },
    ],
};

test("the diagram has port labels and all nodes", () => {
    const svg = render_diagram(DESC);
    assert.match(svg, /^<svg /);
    for(const text of ["access 10", "access 20", "access 30", "trunk 10,20", "Роутер", "Сервер", "sw1", "sw2", "Інтернет"]) {
        assert.ok(svg.includes(text), text);
    }
});

test("names in the diagram are escaped", () => {
    const svg = render_diagram(DESC);
    assert.ok(svg.includes("Клієнт &lt;1&gt;"));
    assert.ok(!svg.includes("<1>"));
});

test("an empty description does not crash", () => {
    assert.match(render_diagram({}), /^<svg /);
});
