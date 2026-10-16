#!/bin/sh
# Each browser inherits its own CPU affinity; Node and other accounts retain theirs.
exec /usr/bin/taskset --cpu-list "$BLUE_CHROMIUM_CPUS" "$BLUE_CHROMIUM_BIN" "$@"
