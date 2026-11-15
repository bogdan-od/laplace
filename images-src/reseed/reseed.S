# open("/dev/urandom", O_WRONLY); ioctl(fd, RNDRESEEDCRNG); exit(ioctl result)
.globl _start
_start:
    mov $5, %eax
    mov $path, %ebx
    mov $1, %ecx
    int $0x80
    test %eax, %eax
    js fail
    mov %eax, %ebx
    mov $54, %eax
    mov $0x5207, %ecx
    int $0x80
    neg %eax
    mov %eax, %ebx
    mov $1, %eax
    int $0x80
fail:
    mov $1, %ebx
    mov $1, %eax
    int $0x80
path: .asciz "/dev/urandom"
