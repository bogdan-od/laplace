const TEXTS = new Map([
    ["connecting", "кімната: з'єднання…"],
    ["lost", "кімната: зв'язок втрачено, перепідключаюсь…"],
    ["replaced", "кімната відкрита в іншій вкладці, ця вкладка від'єднана"],
]);

// Line with the room connection state: empty while everything is fine.
export function show_room_state(room, parent) {
    const line = document.createElement("div");
    line.id = "room_state";
    line.style.color = "#fa4";
    parent.prepend(line);
    const render = () => { line.textContent = TEXTS.get(room.state) ?? ""; };
    room.on("state", render);
    render();
}
