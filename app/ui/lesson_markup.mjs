import { event_times, check_lesson } from "../core/journal.mjs";
import { $, format_clock, ratio_of, save_journal, show_error } from "./common.mjs";

const PERCENT = 100;

// The teacher's lesson markup in the player: "тут" notes and "тепер сам" segments. "Тут" = status.next.
export class Markup {
    #journal = null;
    #items = [];
    #open_from = null;
    #times = [];
    #duration = 0;
    #get_status;
    #jump;

    constructor(get_status, jump) {
        this.#get_status = get_status;
        this.#jump = jump;
        $("mark_note").onclick = () => this.#add_note();
        $("mark_from").onclick = () => this.#start_self();
        $("mark_to").onclick = () => this.#end_self();
        $("save_lesson").onclick = () => this.#save();
    }

    load(journal, duration) {
        this.#journal = journal;
        this.#items = [...(journal.header.lesson ?? [])];
        this.#times = event_times(journal);
        this.#duration = duration;
        this.#open_from = null;
        $("lesson_text").value = "";
        this.#render();
    }

    #add_note() {
        const text = this.#text("Введіть текст пояснення");
        if(text) this.#add({ t: "note", at: this.#here(), text });
    }

    #start_self() {
        this.#open_from = this.#here();
        this.#render();
    }

    #end_self() {
        if(this.#open_from === null) return show_error("Спочатку натисніть «Сам: початок»");
        const text = this.#text("Введіть текст завдання");
        if(!text) return;
        const to = this.#here();
        if(to <= this.#open_from) return show_error("Кінець відрізка має бути після початку");
        if(this.#add({ t: "self", from: this.#open_from, to, text })) this.#open_from = null;
        this.#render();
    }

    #text(message) {
        const text = $("lesson_text").value.trim();
        if(!text) show_error(message);
        return text;
    }

    #here() {
        return this.#get_status()?.next ?? 0;
    }

    #add(item) {
        const items = [...this.#items, item];
        try {
            check_lesson(items, this.#journal.events.length);
        } catch (error) {
            show_error(error.message);
            return false;
        }
        show_error("");
        this.#items = items;
        $("lesson_text").value = "";
        this.#render();
        return true;
    }

    #remove(item) {
        this.#items = this.#items.filter(other => other !== item);
        this.#render();
    }

    #sorted() {
        return [...this.#items].sort((a, b) => (a.at ?? a.from) - (b.at ?? b.from));
    }

    #time_of(index) {
        return index < this.#times.length ? this.#times[index] : this.#duration;
    }

    #render() {
        $("lesson_pending").textContent = this.#open_from === null ? "" : `Початок відрізка: подія ${this.#open_from}`;
        $("lesson_items").replaceChildren(...this.#sorted().map(item => this.#list_item(item)));
        $("lesson_marks").replaceChildren(...this.#sorted().map(item => this.#mark(item)));
    }

    #list_item(item) {
        const li = document.createElement("li");
        const start = item.at ?? item.from;
        li.className = item.t;
        li.textContent = item.t === "note"
            ? `${format_clock(this.#time_of(start))}  пояснення: ${item.text}`
            : `${format_clock(this.#time_of(start))}-${format_clock(this.#time_of(item.to))}  сам: ${item.text}`;
        li.onclick = () => this.#jump(this.#time_of(start));
        const remove = document.createElement("button");
        remove.textContent = "×";
        remove.title = "Видалити мітку";
        remove.onclick = event => { event.stopPropagation(); this.#remove(item); };
        li.append(remove);
        return li;
    }

    #mark(item) {
        const mark = document.createElement("div");
        const start = this.#time_of(item.at ?? item.from);
        mark.className = `lmark ${item.t}`;
        mark.style.left = `${ratio_of(start, this.#duration) * PERCENT}%`;
        if(item.t === "self") mark.style.width = `${ratio_of(this.#time_of(item.to) - start, this.#duration) * PERCENT}%`;
        mark.title = item.text;
        return mark;
    }

    #save() {
        const header = { ...this.#journal.header };
        if(this.#items.length) header.lesson = this.#sorted();
        else delete header.lesson;
        save_journal({ header, events: this.#journal.events }, `${header.machine}-lesson`);
    }
}
