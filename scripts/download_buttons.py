"""The download buttons the README shows, read by gen_download_buttons.py.

Each entry names a button the generator knows and where it leads. The rows,
their order, the colours and the words are the generator's, the same in every
repository.
"""

REPO = "featherdrop"

BUTTONS = {
    "unraid": "https://ca.unraid.net/apps/featherdrop-1fxtgu11wume2t",
    # A browser cannot download an image, so this opens its Docker Hub page,
    # which carries the pull command and every tag.
    "docker": "https://hub.docker.com/r/junkerderprovinz/featherdrop/",
    # A release's "Source code (zip)" is the whole repository at that tag, and
    # GitHub gives the newest one no fixed address, so this leads to the release
    # that lists it.
    "source": "https://github.com/junkerderprovinz/featherdrop/releases/latest",
}
