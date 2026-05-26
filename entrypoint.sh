#!/bin/bash
# Start Xvfb virtual framebuffer in background
Xvfb :99 -screen 0 1024x768x24 -ac +extension GLX -noreset &
export DISPLAY=:99

# Wait for Xvfb display socket to be created
for i in {1..30}; do
    if [ -S /tmp/.X11-unix/X99 ]; then
        break
    fi
    sleep 0.1
done

# Execute main CMD
exec "$@"
