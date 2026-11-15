.include "sse_nan.inc"
.globl _start
.text
_start:
    call run_tests
    movl $1, %eax
    movl $1, %edi
    movl $out, %esi
    movl $(55*16), %edx
    syscall
    movl $60, %eax
    xorl %edi, %edi
    syscall
