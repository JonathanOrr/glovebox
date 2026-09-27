#!/bin/sh
# Starts the TeslaCam viewer and opens it in your web browser.
# The first start downloads what it needs (Python and a few parts, a couple of minutes).
cd "$(dirname "$0")" || exit 1
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
if [ ! -x "$UV" ]; then
  echo "First start: downloading uv, which sets up Python for the viewer..."
  curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
  if [ ! -x "$UV" ]; then
    echo "The download didn't work. Check the internet connection and try again."
    read -r _
    exit 1
  fi
fi
"$UV" run --quiet --no-project --python 3.12 --with-requirements requirements.txt server.py "$@"
