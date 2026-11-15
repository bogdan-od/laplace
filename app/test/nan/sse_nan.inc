# NaN bits in the results of SSE and x87 floating-point operations; code shared by nan32.s (guest) and nan64.s (host).
# Each test puts 16 bytes at out+n*16. The expected value comes from the host's real CPU (nan64); nan.test.mjs compares them.
.macro V name, d0, d1, d2, d3
.balign 16
\name: .long \d0, \d1, \d2, \d3
.endm

.macro T n, op, a, b
    movups \a, %xmm0
    movups \b, %xmm1
    \op %xmm1, %xmm0
    movups %xmm0, out+\n*16
.endm

.data
V z, 0, 0, 0, 0
V one, 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000
V neg4, 0xc0800000, 0xc0800000, 0xc0800000, 0xc0800000
V infp, 0x7f800000, 0x7f800000, 0x7f800000, 0x7f800000
V infn, 0xff800000, 0xff800000, 0xff800000, 0xff800000
V qnp, 0x7fc12345, 0x7fc12345, 0x7fc12345, 0x7fc12345
V qnn, 0xffc12346, 0xffc12346, 0xffc12346, 0xffc12346
V snp, 0x7f800001, 0x7f800001, 0x7f800001, 0x7f800001
V snn, 0xff800002, 0xff800002, 0xff800002, 0xff800002
V mixa, 0, 0x7f800000, 0x7fc12345, 0x3f800000
V mixb, 0, 0xff800000, 0x3f800000, 0xffc00002
V mixc, 0xff800000, 0x7f800001, 0xbf800000, 0x7f800000
V dz, 0, 0, 0, 0
V done, 0, 0x3ff00000, 0, 0x3ff00000
V dneg, 0, 0xbff00000, 0, 0xbff00000
V dinfp, 0, 0x7ff00000, 0, 0x7ff00000
V dinfn, 0, 0xfff00000, 0, 0xfff00000
V dqnp, 0x00000000, 0x7ff81234, 0x00000000, 0x7ff81234
V dqnn, 0x40000000, 0xfff80000, 0x40000000, 0xfff80000
V dsnp, 0x00000001, 0x7ff00000, 0x00000001, 0x7ff00000
V dmixa, 0, 0x7ff00000, 0, 0x7ff81234
V dmixb, 0, 0xfff00000, 0, 0x3ff00000
V sinf_in, 0, 0x7ff00000, 0, 0

.bss
.balign 16
out: .space 4096

.text
run_tests:
    T 0, divss, z, z
    T 1, addss, infp, infn
    T 2, mulss, infp, z
    T 3, sqrtss, one, neg4
    T 4, subss, qnp, one
    T 5, addss, snp, one
    T 6, addss, one, qnn
    T 7, addss, qnp, qnn
    T 8, divps, mixa, mixb
    T 9, mulps, mixa, mixc
    T 10, addps, mixc, mixb
    T 11, subps, mixb, mixa
    T 12, sqrtps, one, mixc
    T 13, rcpps, one, qnn
    T 14, rsqrtss, one, neg4
    T 15, rcpss, one, snn
    T 16, minss, qnp, one
    T 17, maxss, snp, qnn
    T 18, minps, mixa, mixb
    T 19, maxps, mixb, mixc
    T 20, cvtss2sd, dz, snn
    T 21, cvtss2sd, dz, qnp
    T 22, cvtsd2ss, one, dqnn
    T 23, cvtsd2ss, one, dsnp
    T 24, cvtps2pd, dz, mixc
    T 25, cvtpd2ps, one, dqnp
    T 26, haddps, mixa, mixc
    T 27, hsubps, mixb, mixa
    T 28, haddpd, dmixa, dmixb
    T 29, hsubpd, dmixb, dmixa
    T 30, divsd, dz, dz
    T 31, addsd, dinfp, dinfn
    T 32, mulsd, dinfp, dz
    T 33, sqrtsd, done, dneg
    T 34, subsd, dqnp, done
    T 35, addsd, dsnp, done
    T 36, addsd, done, dqnn
    T 37, addsd, dqnp, dqnn
    T 38, divpd, dmixa, dmixb
    T 39, mulpd, dmixa, dmixb
    T 40, addpd, dmixa, dmixb
    T 41, subpd, dmixb, dmixa
    T 42, sqrtpd, done, dmixa
    T 43, minsd, dqnp, done
    T 44, maxsd, dsnp, dqnn
    T 45, minpd, dmixa, dmixb
    T 46, maxpd, dmixb, dmixa
    T 47, divps, one, z
    fldl sinf_in
    fsin
    fstpl out+50*16
    fldl sinf_in
    fcos
    fstpl out+51*16
    fldl sinf_in
    fptan
    fstp %st(0)
    fstpl out+52*16
    fld1
    fchs
    fsqrt
    fstpl out+53*16
    fld1
    fld1
    fchs
    fyl2x
    fstpl out+54*16
    ret
