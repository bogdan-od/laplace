.include "sse_nan.inc"
.globl _start
.text
_start:
    call run_tests
    movl $4, %eax
    movl $1, %ebx
    movl $out, %ecx
    movl $(55*16), %edx
    int $0x80
    movl $1, %eax
    xorl %ebx, %ebx
    int $0x80
