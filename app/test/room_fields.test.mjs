import assert from "node:assert";
import { describe, test } from "node:test";
import {
    clean_group, clean_machine, clean_machines, clean_task_kind, is_field_id, MAX_FIELD_CHARS,
} from "../net/room_fields.mjs";
import { MAX_MACHINES } from "../net/topology.mjs";

describe("room_fields", () => {
    test("is_field_id: valid values", () => {
        for(const ok of ["a", "pc1", "router-2", "Switch_A", "0", "x".repeat(MAX_FIELD_CHARS)]) {
            assert.strictEqual(is_field_id(ok), true, ok);
        }
    });

    test("is_field_id: invalid values and the length limit", () => {
        const bad = ["", " ", "a b", "a/b", "a.b", "a\n", "а", "x".repeat(MAX_FIELD_CHARS + 1), null, undefined, 1, {}, [], ["a"]];
        for(const value of bad) assert.strictEqual(is_field_id(value), false, String(value));
    });

    test("clean_machine and clean_group: a value or null", () => {
        assert.strictEqual(clean_machine("pc1"), "pc1");
        assert.strictEqual(clean_group("g-1"), "g-1");
        assert.strictEqual(clean_machine("a b"), null);
        assert.strictEqual(clean_group(7), null);
        assert.strictEqual(clean_group("x".repeat(65)), null);
    });

    test("clean_machines: an array of up to MAX_MACHINES valid ids", () => {
        assert.deepStrictEqual(clean_machines(["a"]), ["a"]);
        const full = Array.from({ length: MAX_MACHINES }, (_, i) => `m${i}`);
        assert.deepStrictEqual(clean_machines(full), full);
        assert.notStrictEqual(clean_machines(full), full);
    });

    test("clean_machines: anything invalid is dropped entirely", () => {
        const too_many = Array.from({ length: MAX_MACHINES + 1 }, (_, i) => `m${i}`);
        for(const value of [too_many, [], ["a", "b c"], ["a", 1], ["a", "a"], "a", { 0: "a" }, null, undefined]) {
            assert.strictEqual(clean_machines(value), null, JSON.stringify(value));
        }
    });

    test("clean_task_kind: an unknown kind becomes journal", () => {
        assert.strictEqual(clean_task_kind("topology"), "topology");
        assert.strictEqual(clean_task_kind("journal"), "journal");
        for(const value of ["other", "", null, undefined, 1, "Topology"]) assert.strictEqual(clean_task_kind(value), "journal");
    });
});
