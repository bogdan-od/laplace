# The "study" image: the base as in v86's tools/docker/alpine (Alpine 3.21 i386, virt kernel),
# plus tools and documentation for teaching. The root shell stays ash with the prompt
# "localhost:~# ", which the v86 profile depends on (app/profiles.mjs).
FROM docker.io/i386/alpine:3.21.0

ENV KERNEL=virt

# Already in v86's alpine image: nodejs python3 gcc musl-dev netcat-openbsd curl iproute2 tcpdump nano
ENV TOOLS="bash coreutils less nano vim python3 gcc g++ git nodejs musl-dev netcat-openbsd curl iproute2 tcpdump"
ENV DOCS="man-pages mandoc mandoc-apropos mandoc-doc bash-doc coreutils-doc less-doc nano-doc vim-doc python3-doc gcc-doc git-doc netcat-openbsd-doc curl-doc iproute2-doc tcpdump-doc findutils-doc grep-doc sed-doc gawk-doc tar-doc util-linux-doc make-doc file-doc procps-ng-doc"

RUN apk add openrc alpine-base agetty alpine-conf linux-$KERNEL linux-firmware-none $TOOLS $DOCS

RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab
RUN echo "root:" | chpasswd

RUN setup-hostname localhost

# Adding networking.sh script
RUN echo -e "rmmod ne2k-pci && modprobe ne2k-pci\nrmmod virtio-net && modprobe virtio-net\nhwclock -s\nsetup-interfaces -a -r" > /root/networking.sh && chmod +x /root/networking.sh

RUN echo 'console.log("Hello, world!");' > /root/hello.js

# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

# Database for apropos / man -k
RUN makewhatis /usr/share/man

# Generate initramfs with 9p modules
RUN mkinitfs -F "base virtio 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)
