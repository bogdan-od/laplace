import { $, report_errors } from "./common.mjs";

// A lesson for a student: the teacher's journal plays at 1x; at the start of each "тепер сам" segment the replay
// stops and the machine becomes live. Student input in a segment is not stored anywhere.
// Phases (body.dataset.lessonPhase): play, student, retry, solution, solved, done.
export class LessonRun {
    #machine;
    #total;
    #notes;
    #selfs;
    #index = 0;
    #phase = "play";
    #set_live;

    constructor(machine, journal, set_live) {
        const lesson = journal.header.lesson;
        this.#machine = machine;
        this.#total = journal.events.length;
        this.#notes = lesson.filter(item => item.t === "note").sort((a, b) => a.at - b.at);
        this.#selfs = lesson.filter(item => item.t === "self").sort((a, b) => a.from - b.from);
        this.#set_live = set_live;
    }

    async begin() {
        const first = this.#selfs[0];
        this.#machine.limit(first ? first.from : this.#total, Boolean(first));
        this.#machine.on("end", () => this.#arrived());
        this.#machine.on("status", status => this.#show_note(status.next));
        $("lesson_retry").onclick = () => report_errors(() => this.#retry());
        $("lesson_solution").onclick = () => report_errors(() => this.#solution());
        $("lesson_next").onclick = () => report_errors(() => this.#next());
        this.#enter("play");
        const reply = await this.#machine.start();
        if(reply.status.mode === "live") this.#arrived();
    }

    #arrived() {
        if(this.#phase === "solution") return this.#enter("solved");
        this.#enter(this.#selfs[this.#index] ? "student" : "done");
    }

    async #retry() {
        const { from } = this.#selfs[this.#index];
        this.#enter("retry");
        await this.#machine.play_segment({ from, stop: from, live_at_stop: true });
    }

    async #solution() {
        const { from, to } = this.#selfs[this.#index];
        this.#enter("solution");
        await this.#machine.play_segment({ from, stop: to, live_at_stop: false });
    }

    async #next() {
        const { to } = this.#selfs[this.#index];
        this.#index += 1;
        const following = this.#selfs[this.#index];
        this.#enter("play");
        await this.#machine.play_segment({ from: to, stop: following ? following.from : this.#total, live_at_stop: Boolean(following) });
    }

    #enter(phase) {
        this.#phase = phase;
        document.body.dataset.lessonPhase = phase;
        this.#set_live(phase === "student");
        const task = this.#selfs[this.#index];
        const task_visible = task && ["student", "retry", "solution", "solved"].includes(phase);
        $("lesson_task").hidden = !task_visible;
        $("lesson_task_text").textContent = task_visible ? task.text : "";
        $("lesson_retry").disabled = !["student", "solved"].includes(phase);
        $("lesson_solution").disabled = !["student", "solved"].includes(phase);
        $("lesson_next").disabled = phase !== "solved";
        $("note").textContent = phase === "done" ? "Кінець уроку" : "";
    }

    #show_note(next) {
        const note = this.#notes.findLast(item => item.at <= next);
        $("lesson_note").hidden = !note;
        $("lesson_note").textContent = note?.text ?? "";
    }
}
