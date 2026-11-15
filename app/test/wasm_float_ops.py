#!/usr/bin/env python3
"""Lists the functions of v86.wasm whose bodies contain raw wasm float operations (arithmetic, sqrt, min/max,
demote/promote, SIMD f32x4/f64x2). Their NaN result depends on the host CPU, so in the built v86.wasm they must
stay only in the sse_* helpers (v86det/src/rust/cpu/sse_instr.rs) and in code that does not write xmm registers.
Usage: wasm_float_ops.py v86.wasm"""
import sys
from collections import Counter

NAMES = {0x8d: "f32.ceil", 0x8e: "f32.floor", 0x8f: "f32.trunc", 0x90: "f32.nearest", 0x91: "f32.sqrt",
         0x92: "f32.add", 0x93: "f32.sub", 0x94: "f32.mul", 0x95: "f32.div", 0x96: "f32.min", 0x97: "f32.max",
         0x9b: "f64.ceil", 0x9c: "f64.floor", 0x9d: "f64.trunc", 0x9e: "f64.nearest", 0x9f: "f64.sqrt",
         0xa0: "f64.add", 0xa1: "f64.sub", 0xa2: "f64.mul", 0xa3: "f64.div", 0xa4: "f64.min", 0xa5: "f64.max",
         0xb6: "f32.demote_f64", 0xbb: "f64.promote_f32"}
SIMD_FLOAT = {0xdf: "f32x4.div?", 0xe3: "f32x4.sqrt", 0xe4: "f32x4.add", 0xe5: "f32x4.sub", 0xe6: "f32x4.mul",
              0xe7: "f32x4.div", 0xe8: "f32x4.min", 0xe9: "f32x4.max", 0xea: "f32x4.pmin", 0xeb: "f32x4.pmax",
              0xef: "f64x2.sqrt", 0xf0: "f64x2.add", 0xf1: "f64x2.sub", 0xf2: "f64x2.mul", 0xf3: "f64x2.div",
              0xf4: "f64x2.min", 0xf5: "f64x2.max", 0x5e: "f32x4.demote_f64x2_zero", 0x5f: "f64x2.promote_low_f32x4"}
SIMD_FLOAT.pop(0xdf)


def leb(b, i, signed=False):
    result = shift = 0
    while True:
        byte = b[i]; i += 1
        result |= (byte & 0x7f) << shift; shift += 7
        if not byte & 0x80:
            if signed and byte & 0x40:
                result -= 1 << shift
            return result, i


def skip_simd(b, i, op):
    if op <= 11 or 84 <= op <= 93:
        _, i = leb(b, i); _, i = leb(b, i)
        return i + 1 if 84 <= op <= 91 else i
    if op in (12, 13):
        return i + 16
    if 21 <= op <= 34:
        return i + 1
    return i


def scan_body(b, i, end, counter):
    while i < end:
        op = b[i]; i += 1
        if op in NAMES:
            counter[NAMES[op]] += 1
        elif op in (0x02, 0x03, 0x04):
            _, i = leb(b, i, True)
        elif op in (0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xd2, 0xd4):
            _, i = leb(b, i)
        elif op == 0x0e:
            n, i = leb(b, i)
            for _ in range(n + 1):
                _, i = leb(b, i)
        elif op == 0x11:
            _, i = leb(b, i); _, i = leb(b, i)
        elif op == 0x1c:
            n, i = leb(b, i)
            i += n
        elif 0x28 <= op <= 0x3e:
            _, i = leb(b, i); _, i = leb(b, i)
        elif op in (0x3f, 0x40):
            i += 1
        elif op in (0x41, 0x42):
            _, i = leb(b, i, True)
        elif op == 0x43:
            i += 4
        elif op == 0x44:
            i += 8
        elif op == 0xd0:
            i += 1
        elif op == 0xfc:
            sub, i = leb(b, i)
            if sub in (8, 10, 12, 14):
                _, i = leb(b, i); _, i = leb(b, i)
            elif sub in (9, 11, 13, 15, 16, 17):
                _, i = leb(b, i)
        elif op == 0xfd:
            sub, i = leb(b, i)
            if sub in SIMD_FLOAT:
                counter[SIMD_FLOAT[sub]] += 1
            i = skip_simd(b, i, sub)


def main(path):
    b = open(path, "rb").read()
    i = 8
    imported = 0
    bodies = []
    names = {}
    while i < len(b):
        sid = b[i]; i += 1
        size, i = leb(b, i)
        end = i + size
        if sid == 2:
            n, j = leb(b, i)
            for _ in range(n):
                l, j = leb(b, j); j += l
                l, j = leb(b, j); j += l
                kind = b[j]; j += 1
                if kind == 0:
                    _, j = leb(b, j); imported += 1
                elif kind == 1:
                    j += 1; flag = b[j]; j += 1; _, j = leb(b, j)
                    if flag & 1: _, j = leb(b, j)
                elif kind == 2:
                    flag = b[j]; j += 1; _, j = leb(b, j)
                    if flag & 1: _, j = leb(b, j)
                elif kind == 3:
                    j += 2
        elif sid == 10:
            n, j = leb(b, i)
            for _ in range(n):
                bsize, j = leb(b, j)
                bodies.append((j, j + bsize))
                j += bsize
        elif sid == 0:
            l, j = leb(b, i)
            if b[j:j + l] == b"name":
                j += l
                while j < end:
                    sub = b[j]; j += 1
                    ssize, j = leb(b, j)
                    if sub == 1:
                        k, m = leb(b, j)
                        for _ in range(k):
                            idx, m = leb(b, m)
                            nl, m = leb(b, m)
                            names[idx] = b[m:m + nl].decode(errors="replace"); m += nl
                    j += ssize
        i = end
    found = {}
    for k, (start, end) in enumerate(bodies):
        j = start
        local_groups, j = leb(b, j)
        for _ in range(local_groups):
            _, j = leb(b, j); j += 1
        counter = Counter()
        scan_body(b, j, end, counter)
        if counter:
            found[names.get(imported + k, f"func[{imported + k}]")] = counter
    for name in sorted(found):
        print(f"{name}: " + ", ".join(f"{op} x{n}" for op, n in sorted(found[name].items())))
    print(f"-- функцій із сирими дробовими операціями: {len(found)} з {len(bodies)}")


main(sys.argv[1])
