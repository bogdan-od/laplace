#!/bin/sh
# Called by Buildroot: $1 is the root directory. No service start scripts are needed:
# inittab does not call rcS, and the student starts services (dnsmasq and others) by hand.
set -eu
rm -rf "$1/etc/init.d"
# Buildroot makes /etc/dropbear a link to /var/run/dropbear, and that directory is created only by
# S50dropbear, which is absent here. A plain directory: dropbear -R puts the host keys here.
rm -f "$1/etc/dropbear"
mkdir -p "$1/etc/dropbear"
